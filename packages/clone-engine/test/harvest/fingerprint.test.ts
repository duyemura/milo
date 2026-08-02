import { describe, it, expect } from "vitest";
import { fingerprint } from "../../src/harvest/fingerprint.ts";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, formHero, grid3, grid6 } from "./fixtures.ts";

const fp = (s: Parameters<typeof fingerprint>[0]) => fingerprint(s).hash;

describe("structural fingerprint", () => {
  it("video-bg hero and image-bg hero → SAME fingerprint (media.type is a knob)", () => {
    expect(fp(videoBgHero)).toBe(fp(imageBgHero));
  });
  it("left-aligned and right-aligned CTA → SAME fingerprint (align is a knob)", () => {
    expect(fp(ctaLeft)).toBe(fp(ctaRight));
  });
  it("button hero and form hero → DIFFERENT fingerprint (different content model)", () => {
    expect(fp(videoBgHero)).not.toBe(fp(formHero));
  });
  it("3-up and 6-up grid → SAME fingerprint (itemCount is a knob, cardinality collapsed to N)", () => {
    expect(fp(grid3)).toBe(fp(grid6));
  });
  it("is deterministic — same input twice → identical hash", () => {
    expect(fp(grid3)).toBe(fp(grid3));
  });
  it("hash is insensitive to slot-tree object identity but sensitive to slot roles/order", () => {
    const reordered = { ...ctaLeft, slotTree: [ctaLeft.slotTree[1], ctaLeft.slotTree[0], ctaLeft.slotTree[2]] };
    expect(fp(reordered)).not.toBe(fp(ctaLeft));
  });
});
