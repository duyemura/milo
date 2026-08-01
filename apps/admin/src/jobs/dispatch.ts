import { randomUUID } from "node:crypto";
import type { AdminDb } from "../db/index.ts";
import type { JobRow, JobType } from "../db/types.ts";

export interface EngineQueue {
  /** Add an already-queued job id for execution. */
  add(jobId: string): Promise<void>;
}

export interface EnqueueInput {
  siteId: string;
  workspaceId: string;
  companyId: string;
  type: JobType;
  payload?: Record<string, unknown>;
}

const ACTIVE: JobRow["status"][] = ["queued", "running"];

/**
 * Engine output contains ANSI color codes and other control characters; literal
 * U+0000–U+001F is invalid in JSON strings, which would break the UI/API consumers.
 */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export async function queuePosition(db: AdminDb, job: JobRow): Promise<number> {
  // A dispatched/finished job isn't waiting on anything.
  if (job.status !== "waiting") return 0;
  const rows = await db
    .selectFrom("jobs")
    .select(["id"])
    .where("siteId", "=", job.siteId)
    .where("status", "=", "waiting")
    .where("createdAt", "<", job.createdAt)
    .execute();
  const aheadOfActive = rows.length;
  // If anything is active for this site, this job is at least position 1
  const active = await db
    .selectFrom("jobs")
    .select(["id"])
    .where("siteId", "=", job.siteId)
    .where("status", "in", ACTIVE)
    .execute();
  return aheadOfActive + (active.length > 0 ? 1 : 0);
}

/** Insert a waiting job, then try to promote it if the site is idle. */
export async function enqueueJob(
  db: AdminDb,
  queue: EngineQueue,
  input: EnqueueInput,
  now: () => string = () => new Date().toISOString(),
): Promise<JobRow> {
  const id = randomUUID();
  await db
    .insertInto("jobs")
    .values({
      id,
      siteId: input.siteId,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      type: input.type,
      status: "waiting",
      payload: JSON.stringify(input.payload ?? {}),
      error: null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
    })
    .execute();
  await promote(db, queue, input.siteId, now);
  const row = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  return row;
}

/** Per-site serialization: start the oldest waiting job iff no active job for this site. */
export async function promote(
  db: AdminDb,
  queue: EngineQueue,
  siteId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<JobRow | null> {
  const active = await db
    .selectFrom("jobs")
    .select(["id"])
    .where("siteId", "=", siteId)
    .where("status", "in", ACTIVE)
    .execute();
  if (active.length > 0) return null;

  const next = await db
    .selectFrom("jobs")
    .selectAll()
    .where("siteId", "=", siteId)
    .where("status", "=", "waiting")
    .orderBy("createdAt", "asc")
    .limit(1)
    .executeTakeFirst();
  if (!next) return null;

  await db
    .updateTable("jobs")
    .set({ status: "queued" })
    .where("id", "=", next.id)
    .where("status", "=", "waiting")
    .execute();
  await queue.add(next.id);
  void now;
  return next;
}

export async function markRunning(db: AdminDb, jobId: string, now = new Date().toISOString()): Promise<void> {
  await db
    .updateTable("jobs")
    .set({ status: "running", startedAt: now })
    .where("id", "=", jobId)
    .where("status", "=", "queued")
    .execute();
}

export async function finishJob(
  db: AdminDb,
  queue: EngineQueue,
  jobId: string,
  result: { status: "succeeded" } | { status: "failed"; error: string },
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  const job = await db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
  await db
    .updateTable("jobs")
    .set({
      status: result.status,
      error: result.status === "failed" ? stripControl(result.error) : null,
      finishedAt: now(),
    })
    .where("id", "=", jobId)
    .execute();
  await promote(db, queue, job.siteId, now);
}

export async function appendLog(
  db: AdminDb,
  jobId: string,
  line: string,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  const rows = stripControl(line).split("\n").filter((l) => l.trim());
  if (rows.length === 0) return;
  const { maxSeq } = await db
    .selectFrom("job_logs")
    .select((eb) => eb.fn.max("seq").as("maxSeq"))
    .where("jobId", "=", jobId)
    .executeTakeFirstOrThrow();
  let seq = ((maxSeq as number | null) ?? 0) + 1;
  for (const l of rows) {
    await db.insertInto("job_logs").values({ jobId, seq, line: l, createdAt: now() }).execute();
    seq += 1;
  }
}
