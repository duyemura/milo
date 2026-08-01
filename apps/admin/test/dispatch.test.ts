import { describe, expect, it } from "vitest";
import { testDb, fakeQueue, seedRegistry } from "./helpers.ts";
import { enqueueJob, finishJob, queuePosition } from "../src/jobs/dispatch.ts";

let tick = 0;
const nextNow = () => new Date(Date.UTC(2026, 7, 1, 12, 0, tick++)).toISOString();

async function makeSite(db: Awaited<ReturnType<typeof testDb>>, id: string, companyRowId: string) {
  await db
    .insertInto("sites")
    .values({
      id,
      workspaceId: "ws1",
      companyId: companyRowId,
      seedType: "template",
      sourceUrl: null,
      slug: null,
      status: "registered",
      stage: "onboarding",
      active: 1,
      createdAt: nextNow(),
    })
    .execute();
}

describe("dispatch — per-site serialization", () => {
  it("serializes jobs on the same site, parallelizes across sites", async () => {
    const db = await testDb();
    const { companyRowId } = await seedRegistry(db);
    await makeSite(db, "s1", companyRowId);
    await makeSite(db, "s2", companyRowId);
    const queue = fakeQueue();

    const j1 = await enqueueJob(db, queue, { siteId: "s1", workspaceId: "ws1", companyId: companyRowId, type: "build" }, nextNow);
    const j2 = await enqueueJob(db, queue, { siteId: "s1", workspaceId: "ws1", companyId: companyRowId, type: "build" }, nextNow);
    const j3 = await enqueueJob(db, queue, { siteId: "s2", workspaceId: "ws1", companyId: companyRowId, type: "build" }, nextNow);

    // s1: j1 queued (dispatched), j2 waiting. s2: j3 queued — different site runs parallel.
    expect(j1.status).toBe("queued");
    expect(j2.status).toBe("waiting");
    expect(j3.status).toBe("queued");
    expect(queue.added).toEqual([j1.id, j3.id]);
    expect(await queuePosition(db, j2)).toBe(1);

    // Finishing j1 promotes j2.
    await finishJob(db, queue, j1.id, { status: "succeeded" }, nextNow);
    const j2after = await db.selectFrom("jobs").selectAll().where("id", "=", j2.id).executeTakeFirstOrThrow();
    expect(j2after.status).toBe("queued");
    expect(queue.added).toEqual([j1.id, j3.id, j2.id]);
  });

  it("a failing job still promotes the next waiting job", async () => {
    const db = await testDb();
    const { companyRowId } = await seedRegistry(db);
    await makeSite(db, "s1", companyRowId);
    const queue = fakeQueue();

    const j1 = await enqueueJob(db, queue, { siteId: "s1", workspaceId: "ws1", companyId: companyRowId, type: "deploy-staging" }, nextNow);
    const j2 = await enqueueJob(db, queue, { siteId: "s1", workspaceId: "ws1", companyId: companyRowId, type: "promote" }, nextNow);

    await finishJob(db, queue, j1.id, { status: "failed", error: "engine exited 1" }, nextNow);

    const j1after = await db.selectFrom("jobs").selectAll().where("id", "=", j1.id).executeTakeFirstOrThrow();
    expect(j1after.status).toBe("failed");
    expect(j1after.error).toBe("engine exited 1");

    const j2after = await db.selectFrom("jobs").selectAll().where("id", "=", j2.id).executeTakeFirstOrThrow();
    expect(j2after.status).toBe("queued");
    expect(queue.added).toContain(j2.id);
  });
});
