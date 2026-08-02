import { describe, expect, it } from "vitest";
import { progressLabel, progressPercent } from "./progress.ts";

describe("progressLabel", () => {
  it("labels each phase in sentence case", () => {
    expect(progressLabel({ status: "discovering", totalPages: 0, pagesCompleted: 0, current: null, discovered: [], failures: [] })).toBe("Discovering pages…");
    expect(progressLabel({ status: "discovering", totalPages: 6, pagesCompleted: 0, current: null, discovered: [], failures: [] })).toBe("Discovering pages — 6 found");
    expect(progressLabel({ status: "building", totalPages: 6, pagesCompleted: 2, current: { route: "/pricing", phase: "build" }, discovered: [], failures: [] })).toBe("Building — 2/6 (build /pricing)");
    expect(progressLabel({ status: "built", totalPages: 6, pagesCompleted: 6, current: null, discovered: [], failures: [] })).toBe("Built");
  });
  it("clamps percent", () => {
    expect(progressPercent({ status: "built", totalPages: 6, pagesCompleted: 6, current: null, discovered: [], failures: [] })).toBe(100);
    expect(progressPercent({ status: "building", totalPages: 4, pagesCompleted: 2, current: null, discovered: [], failures: [] })).toBe(50);
  });
});
