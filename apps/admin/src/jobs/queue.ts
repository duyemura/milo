import type { AdminDb } from "../db/index.ts";
import type { AdminConfig } from "../config.ts";
import type { EngineQueue } from "./dispatch.ts";
import { finishJob, markRunning, appendLog } from "./dispatch.ts";
import { runJob } from "./runner.ts";

/**
 * Queue seam: dev runs jobs in-process (zero infra); production swaps BullMQ.
 * Both execute the same runJob path and finalize via finishJob → promote.
 */
export function localQueue(deps: { db: AdminDb; config: AdminConfig }): EngineQueue {
  return {
    async add(jobId: string) {
      // Fire-and-forget inline executor; errors are recorded on the job row.
      void execute(deps, jobId).catch(async (err) => {
        try {
          await appendLog(deps.db, jobId, `executor crash: ${String(err)}`);
          await finishJob(deps.db, this as EngineQueue, jobId, {
            status: "failed",
            error: String(err),
          });
        } catch {
          /* db unavailable during shutdown */
        }
      });
    },
  };
}

async function execute(deps: { db: AdminDb; config: AdminConfig }, jobId: string): Promise<void> {
  const { db, config } = deps;
  const job = await db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
  const site = await db.selectFrom("sites").selectAll().where("id", "=", job.siteId).executeTakeFirstOrThrow();
  const queue = localQueue(deps);
  await markRunning(db, jobId);
  try {
    await runJob({ db, config, job, site });
    await finishJob(db, queue, jobId, { status: "succeeded" });
  } catch (err) {
    await appendLog(db, jobId, `ERROR: ${err instanceof Error ? err.message : String(err)}`);
    await finishJob(db, queue, jobId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** BullMQ adapter — worker mode only; the queue instance lives in api/monolith mode. */
export async function bullmqQueue(deps: {
  db: AdminDb;
  config: AdminConfig;
  mode: "producer" | "worker";
}): Promise<EngineQueue> {
  const { Queue, Worker } = await import("bullmq");
  const { default: IORedis } = await import("ioredis");
  const connection = new IORedis(deps.config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("milo-admin-jobs", { connection });

  if (deps.mode === "worker") {
    const self: EngineQueue = { add: (jobId) => queue.add("engine-job", { jobId }).then(() => undefined) };
    new Worker(
      "milo-admin-jobs",
      async (j) => {
        const { jobId } = j.data as { jobId: string };
        await execute(deps, jobId);
      },
      { connection, concurrency: 4 },
    );
    return self;
  }
  return { add: (jobId) => queue.add("engine-job", { jobId }).then(() => undefined) };
}
