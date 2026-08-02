import { describe, expect, it } from "vitest";
import { eventToJsonLine, type EngineEvent } from "@milo/clone-engine";
import { stripControl } from "../src/jobs/dispatch.ts";
import {
  LOG_EVENT_PREFIX,
  encodeLoggedEvent,
  decodeLoggedEvent,
  snapshotFromLogs,
  RunHub,
} from "../src/jobs/run-state.ts";
import { testDb } from "./helpers.ts";

const SEQ: EngineEvent[] = [
  { type: "run.started", origin: "https://x.com" },
  { type: "discover.progress", coreFound: 2, ugcFound: 1, routes: ["/", "/about/", "/blog/p/"] },
  { type: "page.build.started", route: "/" },
  { type: "page.build.done", route: "/" },
  { type: "page.failed", route: "/about/", error: "capture timeout" },
  { type: "assemble.done", pages: 1, fullSiteDir: "/tmp/full-site" },
  { type: "run.completed", ok: 1, failed: 1 },
];

describe("job_logs event encoding", () => {
  it("round-trips every event and survives stripControl", () => {
    for (const e of SEQ) {
      const line = encodeLoggedEvent(e);
      expect(line.startsWith(LOG_EVENT_PREFIX)).toBe(true);
      expect(decodeLoggedEvent(line)).toEqual(e);
      // stripControl runs inside appendLog; the ASCII sentinel must survive it.
      expect(decodeLoggedEvent(stripControl(line))).toEqual(e);
    }
  });

  it("ignores ordinary log lines", () => {
    expect(decodeLoggedEvent("=== CAPTURE / ===")).toBeNull();
    expect(decodeLoggedEvent("")).toBeNull();
    // The engine's raw U+0001 CLI marker is NOT the job_logs encoding.
    expect(decodeLoggedEvent(eventToJsonLine(SEQ[0]))).toBeNull();
  });
});

describe("snapshotFromLogs", () => {
  it("projects a site's persisted events into RunState, skipping plain lines", async () => {
    const db = await testDb();
    const now = new Date().toISOString();
    await db.insertInto("workspaces").values({ id: "w", name: "W", contact: null, status: "active", createdAt: now }).execute();
    await db.insertInto("companies").values({ id: "c", workspaceId: "w", companyId: "pp", name: "C", status: "active", createdAt: now }).execute();
    await db.insertInto("sites").values({ id: "s", workspaceId: "w", companyId: "c", seedType: "clone", sourceUrl: "https://x.com", slug: null, status: "seeding", stage: "onboarding", active: 1, createdAt: now }).execute();
    await db.insertInto("jobs").values({ id: "j", workspaceId: "w", companyId: "c", siteId: "s", type: "seed", status: "running", payload: "{}", error: null, result: null, createdAt: now, startedAt: now, finishedAt: null }).execute();
    let seq = 1;
    for (const e of SEQ) {
      await db.insertInto("job_logs").values({ jobId: "j", seq: seq++, line: encodeLoggedEvent(e), createdAt: now }).execute();
    }
    await db.insertInto("job_logs").values({ jobId: "j", seq: seq++, line: "some plain astro output", createdAt: now }).execute();

    const state = await snapshotFromLogs(db, "s");
    expect(state.status).toBe("built");
    expect(state.totalPages).toBe(3);
    expect(state.pagesCompleted).toBe(2);
    expect(state.failures).toEqual([{ route: "/about/", error: "capture timeout" }]);
  });

  it("returns a clean discovering state for a site with no logs", async () => {
    const db = await testDb();
    const state = await snapshotFromLogs(db, "missing");
    expect(state.status).toBe("discovering");
    expect(state.totalPages).toBe(0);
  });

  it("projects to failed when a wholesale crash appends a synthetic run.completed{ok:0}", async () => {
    // A wholesale engine crash never emits run.completed, so the clone would stay stuck at
    // "building". queue.ts's failure path persists this synthetic terminal event; verify the
    // projection (job_logs = source of truth) then reads as failed for a restarted server.
    const db = await testDb();
    const now = new Date().toISOString();
    await db.insertInto("workspaces").values({ id: "w", name: "W", contact: null, status: "active", createdAt: now }).execute();
    await db.insertInto("companies").values({ id: "c", workspaceId: "w", companyId: "pp", name: "C", status: "active", createdAt: now }).execute();
    await db.insertInto("sites").values({ id: "s", workspaceId: "w", companyId: "c", seedType: "clone", sourceUrl: "https://x.com", slug: null, status: "seeding", stage: "onboarding", active: 1, createdAt: now }).execute();
    await db.insertInto("jobs").values({ id: "j", workspaceId: "w", companyId: "c", siteId: "s", type: "seed", status: "running", payload: "{}", error: null, result: null, createdAt: now, startedAt: now, finishedAt: null }).execute();
    const partial: EngineEvent[] = [
      { type: "run.started", origin: "https://x.com" },
      { type: "discover.progress", coreFound: 3, ugcFound: 0, routes: ["/", "/a/", "/b/"] },
      { type: "page.build.started", route: "/" },
      { type: "run.completed", ok: 0, failed: 0 }, // synthetic terminal from queue.ts catch
    ];
    let seq = 1;
    for (const e of partial) {
      await db.insertInto("job_logs").values({ jobId: "j", seq: seq++, line: encodeLoggedEvent(e), createdAt: now }).execute();
    }
    const state = await snapshotFromLogs(db, "s");
    expect(state.status).toBe("failed");
    expect(state.current).toBeNull();
  });
});

describe("RunHub", () => {
  it("applies events into full-state frames and fans them to subscribers", () => {
    const hub = new RunHub();
    const frames: string[] = [];
    const off = hub.subscribe("s", (state) => frames.push(state.status));
    hub.apply("s", { type: "run.started", origin: "https://x.com" });
    hub.apply("s", { type: "page.build.started", route: "/" });
    hub.apply("s", { type: "run.completed", ok: 1, failed: 0 });
    expect(frames).toEqual(["discovering", "building", "built"]);
    off();
    hub.apply("s", { type: "run.started", origin: "https://y.com" });
    expect(frames).toHaveLength(3); // no delivery after unsubscribe
  });

  it("current() returns live state when present, else projects from logs", async () => {
    const db = await testDb();
    const hub = new RunHub();
    hub.apply("live", { type: "run.started", origin: "https://x.com" });
    hub.apply("live", { type: "page.build.started", route: "/" });
    expect((await hub.current(db, "live")).status).toBe("building");
    expect((await hub.current(db, "cold")).status).toBe("discovering");
  });
});
