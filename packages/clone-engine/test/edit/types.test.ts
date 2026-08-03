import { describe, it, expect } from "vitest";
import { STYLE_PROPS, EditOpSchema } from "../../src/edit/types.ts";

describe("edit types", () => {
  it("STYLE_PROPS is the bounded set", () => {
    expect(STYLE_PROPS).toContain("font-size");
    expect(STYLE_PROPS).toContain("grid-template-columns");
    expect(STYLE_PROPS).not.toContain("position");
  });
});

describe("EditOpSchema — generateSection op", () => {
  it("parses a minimal generateSection op", () => {
    const op = EditOpSchema.parse({ op: "generateSection", role: "hero", brief: "A bold hero for a CrossFit gym." });
    expect(op.op).toBe("generateSection");
    expect((op as { role: string }).role).toBe("hero");
  });

  it("parses generateSection with optional afterSection", () => {
    const op = EditOpSchema.parse({ op: "generateSection", role: "faq", brief: "FAQ about memberships.", afterSection: "HeroSection" });
    expect((op as { afterSection?: string }).afterSection).toBe("HeroSection");
  });

  it("rejects generateSection missing required fields", () => {
    expect(() => EditOpSchema.parse({ op: "generateSection" })).toThrow();
    expect(() => EditOpSchema.parse({ op: "generateSection", role: "hero" })).toThrow(); // missing brief
  });
});
