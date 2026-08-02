import type { HarvestedSection, SlotNode } from "../../src/harvest/types.ts";
import type { TreeEl } from "../../src/types.ts";

/** A tiny section subtree (structure only; styles carried separately). */
function node(tag: string, children: TreeEl[] = [], attrs: Record<string, string> = {}): TreeEl {
  return { id: Math.floor(Math.random() * 1e9), tag, attrs, children };
}

const HERO_SLOTS: SlotNode[] = [
  { role: "headline", card: "1" },
  { role: "subcopy", card: "1" },
  { role: "primary-cta", card: "1" },
  { role: "media", card: "1" },
];

/** Video-background hero — same slots as image-bg, media.type differs (a KNOB). */
export const videoBgHero: HarvestedSection = {
  sourceSite: "siteA",
  role: "hero",
  slotTree: HERO_SLOTS,
  layoutPrimitive: "overlay",
  styles: { "0": { "background-color": "rgb(20, 20, 20)", color: "rgb(255,255,255)", "font-family": "Poppins" } },
  node: node("section", [node("video"), node("h1"), node("p"), node("a")]),
  observed: { mediaType: "video", mediaPosition: "background", align: "center", itemCount: 1 },
};

/** Image-background hero — identical structure, media.type=image. Must share videoBgHero's fingerprint. */
export const imageBgHero: HarvestedSection = {
  ...videoBgHero,
  sourceSite: "siteB",
  node: node("section", [node("img"), node("h1"), node("p"), node("a")]),
  observed: { ...videoBgHero.observed, mediaType: "image" },
};

/** Left-aligned CTA band. */
export const ctaLeft: HarvestedSection = {
  sourceSite: "siteC",
  role: "cta-band",
  slotTree: [
    { role: "headline", card: "1" },
    { role: "subcopy", card: "1" },
    { role: "primary-cta", card: "1" },
  ],
  layoutPrimitive: "stack",
  styles: { "0": { "background-color": "rgb(200, 40, 40)", color: "rgb(255,255,255)", "font-family": "Inter" } },
  node: node("section", [node("h2"), node("p"), node("a")]),
  observed: { mediaType: "none", mediaPosition: "background", align: "left", itemCount: 1 },
};

/** Right-aligned CTA band — identical structure, align differs (a KNOB). Must share ctaLeft's fingerprint. */
export const ctaRight: HarvestedSection = {
  ...ctaLeft,
  sourceSite: "siteD",
  observed: { ...ctaLeft.observed, align: "right" },
};

/** Form hero — DIFFERENT content model: a form{field:N} slot instead of a single cta. New fingerprint. */
export const formHero: HarvestedSection = {
  sourceSite: "siteE",
  role: "hero",
  slotTree: [
    { role: "headline", card: "1" },
    { role: "subcopy", card: "1" },
    { role: "form", card: "1", children: [{ role: "form-field", card: "N" }] },
    { role: "media", card: "1" },
  ],
  layoutPrimitive: "overlay",
  styles: { "0": { "background-color": "rgb(20, 20, 20)", color: "rgb(255,255,255)", "font-family": "Poppins" } },
  node: node("section", [node("img"), node("h1"), node("p"), node("form", [node("input"), node("input")])]),
  observed: { mediaType: "image", mediaPosition: "background", align: "center", itemCount: 1 },
};

/** A 3-up feature grid. */
export const grid3: HarvestedSection = {
  sourceSite: "siteF",
  role: "feature-grid",
  slotTree: [
    { role: "headline", card: "1" },
    { role: "feature-item", card: "N", children: [{ role: "headline", card: "1" }, { role: "body-text", card: "1" }] },
  ],
  layoutPrimitive: "grid",
  styles: { "0": { "background-color": "rgb(255,255,255)", color: "rgb(17,17,17)", "font-family": "Inter" } },
  node: node("section", [node("h2"), node("div"), node("div"), node("div")]),
  observed: { mediaType: "none", mediaPosition: "background", align: "center", itemCount: 3 },
};

/** A 6-up feature grid — same slot tree (cardinality collapsed), itemCount differs (a KNOB). Same fingerprint as grid3. */
export const grid6: HarvestedSection = {
  ...grid3,
  sourceSite: "siteG",
  observed: { ...grid3.observed, itemCount: 6 },
};
