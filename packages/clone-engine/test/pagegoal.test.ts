import { describe, it, expect } from "vitest";
import { evaluateGoal } from "../src/pagegoal.ts";
import type { Ga4Rollup } from "@milo/measurement";

const baseRollup = (): Ga4Rollup => ({
  propertyName: "properties/123", streamName: "test-stream",
  visitors: 100, pageviews: 120, engagementRate: 0.5, activeNow: 2,
  funnel: { visited: 100, engaged: 50, intent: 20, converted: 5 },
  topPages: [], topSources: [],
});

describe("evaluateGoal", () => {
  it("convert goal: achieved when converted > 0 and intent rate >= 10%", () => {
    const r = evaluateGoal("convert", baseRollup());
    expect(r.achieved).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.goal).toBe("convert");
  });

  it("convert goal: not achieved when converted = 0", () => {
    const rollup = baseRollup();
    rollup.funnel.converted = 0;
    rollup.funnel.intent = 0;
    const r = evaluateGoal("convert", rollup);
    expect(r.achieved).toBe(false);
  });

  it("inform goal: achieved when engagement rate >= 40% and scroll_50 implied", () => {
    const rollup = baseRollup();
    rollup.engagementRate = 0.55;
    rollup.funnel.engaged = 55;
    const r = evaluateGoal("inform", rollup);
    expect(r.achieved).toBe(true);
    expect(r.goal).toBe("inform");
  });

  it("inform goal: not achieved when engagement rate < 30%", () => {
    const rollup = baseRollup();
    rollup.engagementRate = 0.25;
    rollup.funnel.engaged = 25;
    const r = evaluateGoal("inform", rollup);
    expect(r.achieved).toBe(false);
  });

  it("none goal: always achieved (no measurable goal)", () => {
    const r = evaluateGoal("none", baseRollup());
    expect(r.achieved).toBe(true);
  });

  it("returns a human-readable summary", () => {
    const r = evaluateGoal("convert", baseRollup());
    expect(r.summary.length).toBeGreaterThan(0);
    expect(typeof r.summary).toBe("string");
  });
});

import { describe as d2, it as it2, expect as e2 } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injectTrackerIntoSite, TRACKER_MARKER } from "../src/pagegoal.ts";

d2("injectTrackerIntoSite", () => {
  it2("injects tracker script into every .html file in a site dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body>hello</body></html>");
    fs.mkdirSync(path.join(dir, "about"));
    fs.writeFileSync(path.join(dir, "about", "index.html"), "<html><head></head><body>about</body></html>");

    injectTrackerIntoSite(dir);

    const root = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    const about = fs.readFileSync(path.join(dir, "about", "index.html"), "utf8");
    e2(root).toContain(TRACKER_MARKER);
    e2(about).toContain(TRACKER_MARKER);
  });

  it2("is idempotent — second call does not double-inject", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker2-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body></body></html>");

    injectTrackerIntoSite(dir);
    injectTrackerIntoSite(dir);

    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    // Should appear exactly once
    e2(html.split(TRACKER_MARKER).length - 1).toBe(1);
  });
});
