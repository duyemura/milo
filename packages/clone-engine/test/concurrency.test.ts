import { describe, it, expect } from "vitest";
import { mapPool, autoConcurrency } from "../src/concurrency.ts";

describe("mapPool", () => {
  it("preserves input order in results", async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0, peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
  it("runs with width 1 for an empty list without hanging", async () => {
    expect(await mapPool([], 4, async (x) => x)).toEqual([]);
  });
  it("falls back to a single worker for a non-finite or zero limit (no dropped items)", async () => {
    expect(await mapPool([1, 2, 3], Number.NaN, async (n) => n)).toEqual([1, 2, 3]);
    expect(await mapPool([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3]);
  });
});

describe("autoConcurrency", () => {
  it("honors an explicit CLONE_CONCURRENCY override", () => {
    expect(autoConcurrency({ env: { CLONE_CONCURRENCY: "7" } })).toBe(7);
  });
  it("ignores a non-numeric/zero override and falls back to auto", () => {
    const k = autoConcurrency({ env: { CLONE_CONCURRENCY: "0" }, hardCap: 8 });
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(8);
  });
  it("clamps between 1 and the hard cap", () => {
    const k = autoConcurrency({ env: {}, hardCap: 8 });
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(8);
  });
});
