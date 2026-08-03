import { describe, it, expect } from "vitest";
import { buildPrompt, classifyBrief, UnsafeBriefError, HARD_NEGATIVES, CATEGORY_TEMPLATES, type SafeImageCategory } from "../../src/assets/safety.ts";

describe("buildPrompt", () => {
  it("fills {subject} into the category template", () => {
    const p = buildPrompt("equipment", "a competition kettlebell");
    expect(p).toContain("a competition kettlebell");
    expect(p).not.toContain("{subject}");
    expect(p).toContain("product photography");
  });

  it("ALWAYS appends the hard negatives verbatim", () => {
    for (const category of Object.keys(CATEGORY_TEMPLATES) as SafeImageCategory[]) {
      const p = buildPrompt(category, "something");
      expect(p).toContain(HARD_NEGATIVES);
      expect(p.endsWith(HARD_NEGATIVES)).toBe(true);
    }
  });

  it("HARD_NEGATIVES spells out the forbidden subjects", () => {
    for (const banned of ["no people", "no faces", "no bodies", "no hands", "no workout poses", "no gym interior", "no logos", "no text"]) {
      expect(HARD_NEGATIVES).toContain(banned);
    }
  });
});

describe("classifyBrief", () => {
  const cases: Array<[string, SafeImageCategory]> = [
    ["close-up of a barbell and weight plates", "equipment"],
    ["a rack of kettlebells", "equipment"],
    ["healthy meal prep containers", "food"],
    ["a protein shake on a counter", "food"],
    ["weathered concrete wall texture", "texture"],
    ["brushed metal surface pattern", "texture"],
    ["geometric architectural lighting detail", "architecture"],
    ["sunrise over a forest trail", "nature"],
    ["a generic water bottle product shot", "product"],
  ];

  for (const [brief, expected] of cases) {
    it(`classifies "${brief}" as ${expected}`, () => {
      expect(classifyBrief(brief)).toBe(expected);
    });
  }

  it("falls back to 'product' for an unrecognized-but-safe brief", () => {
    expect(classifyBrief("a nondescript object on a plain surface")).toBe("product");
  });

  // Regression: "the gym's barbell" and "our gym's kettlebells" must NOT be refused.
  it("allows safe equipment briefs that mention 'gym' possessively", () => {
    expect(() => classifyBrief("the gym's barbell rack close-up")).not.toThrow();
    expect(() => classifyBrief("our gym's kettlebells on a shelf")).not.toThrow();
  });
});

describe("classifyBrief refusals", () => {
  const unsafe = [
    "a person lifting weights",
    "photo of an athlete mid-workout",
    "smiling coach with members",
    "people doing burpees in the gym",
    "the interior of our CrossFit gym",
    "someone's face close up",
    "a body in a workout pose",
    "our team of trainers",
  ];

  for (const brief of unsafe) {
    it(`refuses "${brief}"`, () => {
      expect(() => classifyBrief(brief)).toThrow(UnsafeBriefError);
    });
  }

  it("attaches a safe alternative suggestion to the refusal", () => {
    try {
      classifyBrief("a person lifting weights");
      throw new Error("expected UnsafeBriefError");
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeBriefError);
      expect((e as UnsafeBriefError).suggestion).toBeTruthy();
      expect((e as UnsafeBriefError).suggestion.toLowerCase()).toMatch(/equipment|texture|architecture/);
    }
  });
});
