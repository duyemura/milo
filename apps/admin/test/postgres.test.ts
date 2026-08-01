import { describe, expect, it } from "vitest";
import { createDb, migrateToLatest } from "../src/db/index.ts";
import { seedRegistry } from "./helpers.ts";
import { enqueueJob, queuePosition } from "../src/jobs/dispatch.ts";

const PG_TEST_URL = process.env["PG_TEST_URL"];

/**
 * Postgres dialect parity. Skipped unless PG_TEST_URL points at a scratch database
 * (e.g. `PG_TEST_URL=postgres://localhost:5432/milo_admin_test pnpm test`).
 */
describe.skipIf(!PG_TEST_URL)("postgres dialect", () => {
  it("migrates and roundtrips; dispatch lock + queue positions behave identically to sqlite", async () => {
    const db = createDb({ dbUrl: PG_TEST_URL });
    await migrateToLatest(db);
    const { workspaceId, companyRowId } = await seedRegistry(db);

    const ws = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    expect(ws.name).toBe("Acme Fitness Group");

    await db
      .insertInto("sites")
      .values({
        id: "pg-s1",
        workspaceId,
        companyId: companyRowId,
        seedType: "template",
        sourceUrl: null,
        slug: null,
        status: "registered",
        stage: "onboarding",
        active: 1,
        createdAt: new Date().toISOString(),
      })
      .execute();

    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 7, 1, 13, 0, tick++)).toISOString();
    const adds: string[] = [];
    const queue = { add: async (jobId: string) => { adds.push(jobId); } };
    const j1 = await enqueueJob(db, queue, { siteId: "pg-s1", workspaceId, companyId: companyRowId, type: "build" }, now);
    const j2 = await enqueueJob(db, queue, { siteId: "pg-s1", workspaceId, companyId: companyRowId, type: "build" }, now);
    expect(j1.status).toBe("queued");
    expect(j2.status).toBe("waiting");
    expect(await queuePosition(db, j2)).toBe(1);

    await db.destroy();
  });
});
