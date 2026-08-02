import { describe, expect, it } from "vitest";
import { eventToJsonLine, type EngineEvent } from "@milo/clone-engine";
import { makeEventBridge } from "../src/jobs/event-bridge.ts";
import { snapshotFromLogs, RunHub } from "../src/jobs/run-state.ts";
import { testDb } from "./helpers.ts";

async function seedJob(db: Awaited<ReturnType<typeof testDb>>) {
  const now = new Date().toISOString();
  await db.insertInto("workspaces").values({ id: "w", name: "W", contact: null, status: "active", createdAt: now }).execute();
  await db.insertInto("companies").values({ id: "c", workspaceId: "w", companyId: "pp", name: "C", status: "active", createdAt: now }).execute();
  await db.insertInto("sites").values({ id: "s", workspaceId: "w", companyId: "c", seedType: "clone", sourceUrl: "https://x.com", slug: null, status: "seeding", stage: "onboarding", active: 1, createdAt: now }).execute();
  await db.insertInto("jobs").values({ id: "j", workspaceId: "w", companyId: "c", siteId: "s", type: "seed", status: "running", payload: "{}", error: null, result: null, createdAt: now, startedAt: now, finishedAt: null }).execute();
}

describe("makeEventBridge", () => {
  it("routes CLI event lines to job_logs + the hub, and logs plain lines", async () => {
    const db = await testDb();
    await seedJob(db);
    const hub = new RunHub();
    const bridge = makeEventBridge({ db, jobId: "j", siteId: "s", hub });

    const events: EngineEvent[] = [
      { type: "run.started", origin: "https://x.com" },
      { type: "discover.progress", coreFound: 1, ugcFound: 0, routes: ["/"] },
      { type: "page.build.started", route: "/" },
      { type: "page.build.done", route: "/" },
      { type: "run.completed", ok: 1, failed: 0 },
    ];
    // Interleave a plain astro line, exactly as the CLI emits (events carry U+0001).
    bridge.onLine(eventToJsonLine(events[0]));
    bridge.onLine(eventToJsonLine(events[1]));
    bridge.onLine("building astro entry / ...");
    bridge.onLine(eventToJsonLine(events[2]));
    bridge.onLine(eventToJsonLine(events[3]));
    bridge.onLine(eventToJsonLine(events[4]));
    await bridge.drain();

    // Hub reflects the terminal state.
    expect((await hub.current(db, "s")).status).toBe("built");
    // Projection from persisted logs matches (proves ASCII re-encoding round-trips).
    const projected = await snapshotFromLogs(db, "s");
    expect(projected.status).toBe("built");
    expect(projected.totalPages).toBe(1);
    expect(projected.pagesCompleted).toBe(1);
    // The plain line is stored too (as an ordinary log row).
    const logs = await db.selectFrom("job_logs").selectAll().where("jobId", "=", "j").orderBy("seq", "asc").execute();
    expect(logs.some((l) => l.line.includes("building astro entry"))).toBe(true);
  });
});
