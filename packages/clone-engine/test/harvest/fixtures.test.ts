import { describe, it, expect } from "vitest";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, formHero, grid3, grid6 } from "./fixtures.ts";

describe("canonical fixtures", () => {
  it("video-bg and image-bg hero share slotTree + layout, differ only in observed.mediaType", () => {
    expect(imageBgHero.slotTree).toEqual(videoBgHero.slotTree);
    expect(imageBgHero.layoutPrimitive).toBe(videoBgHero.layoutPrimitive);
    expect(imageBgHero.observed.mediaType).not.toBe(videoBgHero.observed.mediaType);
  });
  it("L/R CTA share slotTree, differ only in observed.align", () => {
    expect(ctaRight.slotTree).toEqual(ctaLeft.slotTree);
    expect(ctaRight.observed.align).not.toBe(ctaLeft.observed.align);
  });
  it("form hero has a form slot the button hero does not", () => {
    expect(videoBgHero.slotTree.some((s) => s.role === "form")).toBe(false);
    expect(formHero.slotTree.some((s) => s.role === "form")).toBe(true);
  });
  it("grid3 and grid6 share slotTree, differ only in observed.itemCount", () => {
    expect(grid6.slotTree).toEqual(grid3.slotTree);
    expect(grid6.observed.itemCount).not.toBe(grid3.observed.itemCount);
  });
});
