import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AdminConfig } from "../src/config.ts";
import { createDb, migrateToLatest, type AdminDb } from "../src/db/index.ts";
import { buildApp } from "../src/server/app.ts";
import type { EngineQueue } from "../src/jobs/dispatch.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function testConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return loadConfig({
    ...process.env,
    AUTH_MODE: "dev",
    QUEUE_DRIVER: "local",
    DB_PATH: ":memory:",
    REPO_ROOT: path.resolve(HERE, "..", "..", ".."),
  } as NodeJS.ProcessEnv);
}

export async function testDb(): Promise<AdminDb> {
  const db = createDb(":memory:");
  await migrateToLatest(db);
  return db;
}

/** Queue that records adds without executing — routes/dispatch tests never run engines. */
export function fakeQueue(added: string[] = []): EngineQueue & { added: string[] } {
  return {
    added,
    async add(jobId: string) {
      added.push(jobId);
    },
  };
}

export async function testApp(queue: EngineQueue = fakeQueue()) {
  const config = testConfig();
  const db = await testDb();
  const app = await buildApp({ config, db, queue });
  return { app, db, config };
}

export async function seedRegistry(db: AdminDb) {
  const now = new Date().toISOString();
  await db
    .insertInto("workspaces")
    .values({ id: "ws1", name: "Acme Fitness Group", contact: null, status: "active", createdAt: now })
    .execute();
  await db
    .insertInto("companies")
    .values({ id: "co1", workspaceId: "ws1", companyId: "pp-co-1", name: "Iron Anchor", status: "active", createdAt: now })
    .execute();
  return { workspaceId: "ws1", companyRowId: "co1" };
}
