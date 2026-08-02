import { describe, it, expect } from "vitest";
import { enumerateKnobs, modalDefaults } from "../../src/harvest/knobs.ts";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, grid3, grid6 } from "./fixtures.ts";

describe("knob enumeration", () => {
  it("collects the union of media types seen across members (image + video)", () => {
    const knobs = enumerateKnobs([videoBgHero, imageBgHero]);
    expect(knobs.mediaType.sort()).toEqual(["image", "video"]);
  });
  it("collects the union of alignments seen (left + right)", () => {
    const knobs = enumerateKnobs([ctaLeft, ctaRight]);
    expect(knobs.align.sort()).toEqual(["left", "right"]);
  });
  it("derives itemCount range from observed counts (3..6)", () => {
    const knobs = enumerateKnobs([grid3, grid6]);
    expect(knobs.itemCount).toEqual({ min: 3, max: 6 });
  });
  it("modal defaults pick the most common observed value", () => {
    // two image, one video → default mediaType=image
    const d = modalDefaults([imageBgHero, { ...imageBgHero, sourceSite: "s2" }, videoBgHero]);
    expect(d.mediaType).toBe("image");
  });
  it("always includes density knob defaulting to 'default' (no residual density signal yet)", () => {
    const knobs = enumerateKnobs([ctaLeft]);
    expect(knobs.density).toContain("default");
  });
});
