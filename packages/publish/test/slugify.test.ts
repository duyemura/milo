import { describe, expect, it } from "vitest";
import { toKebab, generateSuffix, buildSlug } from "../src/slugify.ts";

describe("toKebab", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(toKebab("Iron Anchor CrossFit")).toBe("iron-anchor-crossfit");
  });
  it("collapses multiple non-alphanumeric chars into one hyphen", () => {
    expect(toKebab("The   Gym & More!")).toBe("the-gym-more");
  });
  it("trims leading and trailing hyphens", () => {
    expect(toKebab("  --gym--  ")).toBe("gym");
  });
  it("handles all-numeric name", () => {
    expect(toKebab("123 Fit")).toBe("123-fit");
  });
});

describe("generateSuffix", () => {
  it("returns exactly 4 lowercase hex characters", () => {
    const suffix = generateSuffix();
    expect(suffix).toMatch(/^[0-9a-f]{4}$/);
  });
  it("returns different values on successive calls (probabilistic)", () => {
    const results = new Set(Array.from({ length: 20 }, () => generateSuffix()));
    expect(results.size).toBeGreaterThan(1);
  });
});

describe("buildSlug", () => {
  it("combines kebab name and suffix with a hyphen", () => {
    expect(buildSlug("Iron Anchor CrossFit", "4s1a")).toBe("iron-anchor-crossfit-4s1a");
  });
});
