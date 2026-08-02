import { describe, it, expect } from "vitest";
import type { HarvestedSection, LayoutPrimitive } from "../../src/harvest/types.ts";

describe("harvest types", () => {
  it("compiles and constructs a minimal HarvestedSection", () => {
    const s: HarvestedSection = {
      sourceSite: "x",
      role: "cta-band",
      slotTree: [{ role: "headline", card: "1" }],
      layoutPrimitive: "stack",
      styles: {},
      node: { id: 0, tag: "section", attrs: {}, children: [] },
      observed: { mediaType: "none", mediaPosition: "background", align: "center", itemCount: 1 },
    };
    expect(s.role).toBe("cta-band");
    const p: LayoutPrimitive = "grid";
    expect(p).toBe("grid");
  });
});
