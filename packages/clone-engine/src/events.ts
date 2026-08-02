/**
 * events.ts — the clone-engine progress event contract.
 *
 * Pure: no I/O, no engine imports. Defines the EngineEvent union, a pure RunState
 * reducer/projection (job_logs → RunState in the admin app), and a marker-prefixed
 * JSON-line serializer used by the CLI `--emit-events` mode so a parent process can
 * distinguish structured events from ordinary stdout.
 *
 * The seam is ADDITIVE: buildSite/buildSiteAuto emit these when an onEvent sink is
 * attached, and behave identically when it is not.
 */

export type EnginePhase = "capture" | "project" | "build";

export type EngineEvent =
  // --- clone lifecycle (emitted by buildSite / buildSiteAuto) ---
  | { type: "run.started"; origin: string }
  | { type: "discover.progress"; coreFound: number; ugcFound: number; routes: string[] }
  | { type: "page.capture.started"; route: string }
  | { type: "page.capture.done"; route: string }
  | { type: "page.project.started"; route: string }
  | { type: "page.project.done"; route: string }
  | { type: "page.build.started"; route: string }
  | { type: "page.build.done"; route: string }
  | { type: "page.failed"; route: string; error: string }
  | { type: "assemble.done"; pages: number; fullSiteDir: string }
  | { type: "report.done"; reportJsonPath: string; reportHtmlPath: string }
  | { type: "run.completed"; ok: number; failed: number }
  // --- edit lifecycle (DEFINED here; EMITTED in Plan 2 with POST /edits) ---
  | { type: "edit.started"; message: string }
  | { type: "edit.plan"; opsSummary: string }
  | { type: "edit.apply" }
  | { type: "edit.verify"; ok: boolean; correctionAttempt: number }
  | { type: "edit.rebuilt"; route: string; ms: number }
  | { type: "edit.done"; friendly: string }
  | { type: "edit.failed"; reason: string };

export type EngineEventSink = (e: EngineEvent) => void;

export interface RunState {
  status: "discovering" | "building" | "built" | "failed";
  totalPages: number;
  pagesCompleted: number;
  /** Last active (or currently processing) page + phase; null after run.completed. */
  current: { route: string; phase: EnginePhase } | null;
  discovered: string[];
  failures: { route: string; error: string }[];
}

export function initialRunState(): RunState {
  return {
    status: "discovering",
    totalPages: 0,
    pagesCompleted: 0,
    current: null,
    discovered: [],
    failures: [],
  };
}

/** Pure fold of one event into the running state. No mutation. */
export function reduceRunState(state: RunState, e: EngineEvent): RunState {
  switch (e.type) {
    case "run.started":
      return initialRunState();
    case "discover.progress":
      return { ...state, totalPages: e.coreFound + e.ugcFound, discovered: e.routes };
    case "page.capture.started":
      return { ...state, status: "building", current: { route: e.route, phase: "capture" } };
    case "page.project.started":
      return { ...state, status: "building", current: { route: e.route, phase: "project" } };
    case "page.build.started":
      return { ...state, status: "building", current: { route: e.route, phase: "build" } };
    case "page.build.done":
      return { ...state, pagesCompleted: state.pagesCompleted + 1 };
    case "page.failed":
      return {
        ...state,
        pagesCompleted: state.pagesCompleted + 1,
        failures: [...state.failures, { route: e.route, error: e.error }],
      };
    case "run.completed":
      return { ...state, status: e.ok === 0 ? "failed" : "built", current: null };
    // assemble.done / report.done / page.*.done(capture,project) / edit.* — no RunState change.
    default:
      return state;
  }
}

/** Replay an event log into a RunState (admin: job_logs → RunState). */
export function projectRunState(events: EngineEvent[]): RunState {
  return events.reduce(reduceRunState, initialRunState());
}

// --- Line serialization for the CLI --emit-events bridge ---

/**
 * A U+0001 (SOH) control sentinel + human-readable prefix. U+0001 never appears in
 * normal stdout text, so a parent process can reliably pick event lines out of
 * interleaved console output.
 */
export const EVENT_MARKER = "\u0001MILO_EVENT:";

export function eventToJsonLine(e: EngineEvent): string {
  return EVENT_MARKER + JSON.stringify(e);
}

/** Parse one stdout line; returns the event, or null if the line carries no valid event. */
export function parseEventLine(line: string): EngineEvent | null {
  const i = line.indexOf(EVENT_MARKER);
  if (i === -1) return null;
  const json = line.slice(i + EVENT_MARKER.length);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as EngineEvent;
    }
    return null;
  } catch {
    return null;
  }
}
