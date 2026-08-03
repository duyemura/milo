import { describe, it, expect } from "vitest";
import { classifyByResidual, offBrandLiterals } from "../../src/harvest/classify.ts";

describe("classifyByResidual", () => {
  it("keeps a low-residual section as adaptive", () => {
    const c = classifyByResidual(0.05, 0.2, true);
    expect(c.verdict).toBe("adaptive");
  });
  it("rejects a high-residual section", () => {
    const c = classifyByResidual(0.6, 0.2, true);
    expect(c.verdict).toBe("reject");
    expect(c.reasons.join(" ")).toMatch(/residual/);
  });
  it("rejects a low-residual section that FAILED the swap-brand oracle (oracle is the gate)", () => {
    const c = classifyByResidual(0.05, 0.2, false);
    expect(c.verdict).toBe("reject");
    expect(c.swapBrandClean).toBe(false);
    expect(c.reasons.join(" ")).toMatch(/swap-brand/);
  });
});

describe("offBrandLiterals", () => {
  it("returns [] when the CSS references only var(--*) tokens", () => {
    const css = "[data-component=X]{background-color:var(--color-primary);color:var(--color-surface);}";
    expect(offBrandLiterals(css)).toEqual([]);
  });
  it("flags a raw color literal that should have been a token", () => {
    const css = "[data-component=X]{background-color:#ff0000;color:var(--color-surface);}";
    expect(offBrandLiterals(css)).toContain("#ff0000");
  });
  it("flags an rgb() literal", () => {
    const css = ".g0{color:rgb(13, 240, 111);}";
    expect(offBrandLiterals(css)).toContain("rgb(13, 240, 111)");
  });
});
