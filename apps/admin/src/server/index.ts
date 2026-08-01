import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { createDb, migrateToLatest } from "../db/index.ts";
import { localQueue, bullmqQueue } from "../jobs/queue.ts";
import { buildApp } from "./app.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const service = process.env["SERVICE"] ?? "monolith";

  await mkdir(config.dataDir, { recursive: true });
  const db = createDb(config.dbPath);
  await migrateToLatest(db);

  if (service === "worker" && config.queueDriver !== "bullmq") {
    // Local driver runs jobs in-process inside the api/monolith process; a dedicated
    // worker mode only exists for the BullMQ driver.
    throw new Error("SERVICE=worker requires QUEUE_DRIVER=bullmq.");
  }

  const queue =
    config.queueDriver === "bullmq"
      ? // api-only mode only enqueues; monolith and worker both run processors.
        await bullmqQueue({ db, config, mode: service === "api" ? "producer" : "worker" })
      : localQueue({ db, config });

  if (service !== "worker") {
    const app = await buildApp({ config, db, queue });
    await app.listen({ port: config.port, host: config.host });
    console.log(`[admin] ${service} listening on http://${config.host}:${config.port} (auth=${config.authMode}, queue=${config.queueDriver})`);
  } else {
    console.log("[admin] worker started (bullmq)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
