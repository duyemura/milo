import type { AdminDb } from "../db/index.ts";
import {
  initialRunState,
  reduceRunState,
  projectRunState,
  type EngineEvent,
  type RunState,
} from "@milo/clone-engine";

/**
 * Events are persisted into job_logs alongside plain log lines. The engine's own
 * U+0001 EVENT_MARKER can't survive admin's stripControl() (it strips U+0000–U+001F),
 * so job_logs uses this printable-ASCII sentinel. Plain log lines never start with it,
 * so decodeLoggedEvent cleanly separates events from noise when projecting.
 */
export const LOG_EVENT_PREFIX = "@@MILO_EVENT@@ ";

export function encodeLoggedEvent(e: EngineEvent): string {
  return LOG_EVENT_PREFIX + JSON.stringify(e);
}

export function decodeLoggedEvent(line: string): EngineEvent | null {
  if (!line.startsWith(LOG_EVENT_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(LOG_EVENT_PREFIX.length)) as EngineEvent;
  } catch {
    return null;
  }
}

/**
 * Reconstruct a site's RunState by projecting every persisted event across all its
 * jobs, in (job createdAt, log seq) order. This is how a late-joining browser or a
 * restarted server rebuilds identical state — job_logs is the only source of truth.
 */
export async function snapshotFromLogs(db: AdminDb, siteId: string): Promise<RunState> {
  const rows = await db
    .selectFrom("job_logs")
    .innerJoin("jobs", "jobs.id", "job_logs.jobId")
    .select(["job_logs.line"])
    .where("jobs.siteId", "=", siteId)
    .orderBy("jobs.createdAt", "asc")
    .orderBy("job_logs.seq", "asc")
    .execute();
  const events: EngineEvent[] = [];
  for (const r of rows) {
    const e = decodeLoggedEvent(r.line);
    if (e) events.push(e);
  }
  return projectRunState(events);
}

export type RunFrameListener = (state: RunState) => void;

/**
 * In-memory per-site RunState + SSE fan-out. The runner is the single writer: it calls
 * apply() for every engine event, which folds it into the site's live state and pushes
 * the FULL new state to every subscriber. Full-state frames mean a client just replaces
 * its state per frame (no client-side reducer, no lost-delta accounting). job_logs stays
 * authoritative; this is a live cache so connected browsers avoid polling.
 */
export class RunHub {
  private states = new Map<string, RunState>();
  private listeners = new Map<string, Set<RunFrameListener>>();

  apply(siteId: string, e: EngineEvent): void {
    const next = reduceRunState(this.states.get(siteId) ?? initialRunState(), e);
    this.states.set(siteId, next);
    for (const fn of this.listeners.get(siteId) ?? []) {
      try {
        fn(next);
      } catch {
        // A broken SSE client must never wedge a running build.
      }
    }
  }

  /** Live state if this process has streamed anything for the site, else project from logs. */
  async current(db: AdminDb, siteId: string): Promise<RunState> {
    return this.states.get(siteId) ?? (await snapshotFromLogs(db, siteId));
  }

  subscribe(siteId: string, fn: RunFrameListener): () => void {
    let set = this.listeners.get(siteId);
    if (!set) {
      set = new Set();
      this.listeners.set(siteId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(siteId);
    };
  }
}
