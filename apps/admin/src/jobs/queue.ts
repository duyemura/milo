import type { AdminDb } from "../db/index.ts";
import type { AdminConfig } from "../config.ts";
import type { EngineQueue } from "./dispatch.ts";
import { finishJob, markRunning, appendLog } from "./dispatch.ts";
import { runJob } from "./runner.ts";
import { encodeLoggedEvent, type RunHub } from "./run-state.ts";

/**
 * Queue seam: dev runs jobs in-process (zero infra); production swaps BullMQ.
 * Both execute the same runJob path and finalize via finishJob → promote. On finish,
 * the next waiting job for the site is promoted onto the SAME queue (never a local
 * executor in distributed mode).
 */
export function localQueue(deps: { db: AdminDb; config: AdminConfig; hub: RunHub }): EngineQueue {
  const self: EngineQueue = {
    async add(jobId: string) {
      // Fire-and-forget inline executor; errors are recorded on the job row.
      void execute(deps, jobId, self).catch(async (err) => {
        try {
          await appendLog(deps.db, jobId, `executor crash: ${String(err)}`);
          await finishJob(deps.db, self, jobId, {
            status: "failed",
            error: String(err),
          });
        } catch {
          /* db unavailable during shutdown */
        }
      });
    },
  };
  return self;
}

async function execute(
  deps: { db: AdminDb; config: AdminConfig; hub: RunHub },
  jobId: string,
  queue: EngineQueue,
): Promise<void> {
  const { db, config, hub } = deps;
  const job = await db.selectFrom("jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
  const site = await db.selectFrom("sites").selectAll().where("id", "=", job.siteId).executeTakeFirstOrThrow();
  await markRunning(db, jobId);
  try {
    const text = await runJob({ db, config, job, site, hub });
    await finishJob(db, queue, jobId, { status: "succeeded", text: typeof text === "string" ? text : undefined });
  } catch (err) {
    await appendLog(db, jobId, `ERROR: ${err instanceof Error ? err.message : String(err)}`);
    await db.updateTable("sites").set({ status: "error" }).where("id", "=", job.siteId).execute();
    // A wholesale engine crash (discovery throwing, or a whole build pass throwing — as
    // opposed to per-page page.failed) never emits run.completed, so the clone's RunState
    // would stay stuck at "building" forever: for live SSE clients AND any snapshotFromLogs
    // rebuild, since job_logs is the source of truth. Persist + apply a synthetic terminal
    // event so the projection reflects failure. Only the clone seed emits RunState events,
    // so scope this to it; reduceRunState maps run.completed{ok:0} → status "failed".
    if (job.type === "seed" && site.seedType === "clone") {
      const terminal = { type: "run.completed", ok: 0, failed: 0 } as const;
      await appendLog(db, jobId, encodeLoggedEvent(terminal));
      hub.apply(job.siteId, terminal);
    }
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
  hub: RunHub;
}): Promise<EngineQueue> {
  const { Queue, Worker } = await import("bullmq");
  const { default: IORedis } = await import("ioredis");
  const connection = new IORedis(deps.config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("milo-admin-jobs", { connection });

  const self: EngineQueue = {
    add: (jobId) => queue.add("engine-job", { jobId }).then(() => undefined),
  };

  if (deps.mode === "worker") {
    new Worker(
      "milo-admin-jobs",
      async (j) => {
        const { jobId } = j.data as { jobId: string };
        await execute(deps, jobId, self);
      },
      { connection, concurrency: 4 },
    );
  }
  return self;
}
