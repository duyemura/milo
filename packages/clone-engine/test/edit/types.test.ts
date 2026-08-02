import { describe, it, expect } from "vitest";
import { STYLE_PROPS } from "../../src/edit/types.ts";
describe("edit types", () => {
  it("STYLE_PROPS is the bounded set", () => {
    expect(STYLE_PROPS).toContain("font-size");
    expect(STYLE_PROPS).toContain("grid-template-columns");
    expect(STYLE_PROPS).not.toContain("position"); // not in the bounded set
  });
});
