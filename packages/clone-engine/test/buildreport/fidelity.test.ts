import { describe, it, expect } from "vitest";
import { computeFidelityPct } from "../../src/buildreport/checks/fidelity.ts";
import type { PixelDiffResult } from "../../src/pixel.ts";

const result = (pct: number): PixelDiffResult => ({ d: 0, total: 1000, pct, dimMatch: true, ah: 100, bh: 100 });

describe("computeFidelityPct", () => {
  it("0% diff → 100% fidelity", () => {
    expect(computeFidelityPct(result(0))).toBe(100);
  });

  it("100% diff → 0% fidelity", () => {
    expect(computeFidelityPct(result(100))).toBe(0);
  });

  it("25% diff → 75% fidelity", () => {
    expect(computeFidelityPct(result(25))).toBeCloseTo(75, 1);
  });
});
