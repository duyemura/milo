import type { TreeEl, StyleMap } from "../types.ts";
import type { TemplateSectionRole } from "../edit/templates.ts";
import type { SlotNode, LayoutPrimitive, HarvestedSection } from "./types.ts";
import { isEl, elKids, findTag } from "../tree.ts";

/** Map a tag (+ context) to a semantic slot role. Coarse by design — structure, not copy. */
function slotRoleOf(el: TreeEl): string {
  const t = el.tag;
  if (t === "h1" || t === "h2") return "headline";
  if (t === "h3" || t === "h4") return "headline";
  if (t === "p" || t === "span") return "body-text";
  if (t === "a" || t === "button") return "primary-cta";
  if (t === "form") return "form";
  if (t === "input" || t === "textarea" || t === "select") return "form-field";
  if (t === "img" || t === "video" || t === "picture") return "media";
  return "body-text";
}

/** True if this element (or its immediate class) reads as a full-bleed background media element. */
function isBackgroundMedia(el: TreeEl): boolean {
  if (el.tag !== "img" && el.tag !== "video" && el.tag !== "picture") return false;
  const cls = (el.attrs["class"] ?? "").toLowerCase();
  return /bg|background|hero|cover|full/.test(cls);
}

/**
 * Group consecutive sibling elements that share the same tag + child-shape into one
 * repeating group. Returns groups of >=2 as N-cardinality, singletons as 1.
 */
function groupSiblings(kids: TreeEl[]): Array<{ reps: TreeEl[]; card: "1" | "N" }> {
  const shape = (el: TreeEl) => el.tag + ":" + elKids(el).map((c) => c.tag).join("-");
  const out: Array<{ reps: TreeEl[]; card: "1" | "N" }> = [];
  let i = 0;
  while (i < kids.length) {
    const s = shape(kids[i]);
    let j = i + 1;
    while (j < kids.length && shape(kids[j]) === s) j++;
    const reps = kids.slice(i, j);
    out.push({ reps, card: reps.length >= 2 ? "N" : "1" });
    i = j;
  }
  return out;
}

/** Build the ordered semantic slot tree of a section subtree (cardinality collapsed). */
function slotTreeOf(section: TreeEl): SlotNode[] {
  const kids = elKids(section);
  const groups = groupSiblings(kids);
  const slots: SlotNode[] = [];
  for (const g of groups) {
    const rep = g.reps[0];
    const grandKids = elKids(rep);
    if (grandKids.length > 0 && (g.card === "N" || rep.tag === "form" || rep.tag === "div")) {
      const role = rep.tag === "form" ? "form" : g.card === "N" ? "feature-item" : slotRoleOf(rep);
      const children = elKids(rep).map((c) => ({ role: slotRoleOf(c), card: "1" as const }));
      slots.push(children.length ? { role, card: g.card, children } : { role, card: g.card });
    } else {
      slots.push({ role: slotRoleOf(rep), card: g.card });
    }
  }
  return slots;
}

/** Derive the coarse layout primitive from the tokenized structure (not pixel positions). */
export function layoutPrimitiveOf(section: TreeEl): LayoutPrimitive {
  const kids = elKids(section);
  if (kids.some(isBackgroundMedia)) return "overlay";
  const groups = groupSiblings(kids);
  if (groups.some((g) => g.card === "N")) return "grid";
  const hasMedia = kids.some((k) => k.tag === "img" || k.tag === "video" || k.tag === "picture");
  const hasContent = kids.some((k) => k.tag !== "img" && k.tag !== "video" && k.tag !== "picture");
  if (hasMedia && hasContent && kids.length === 2) return "split";
  return "stack";
}

/** Read the observed (per-instance) knob values off a captured section. */
function observeKnobs(section: TreeEl): HarvestedSection["observed"] {
  const kids = elKids(section);
  const bgMedia = kids.find(isBackgroundMedia);
  const anyMedia = kids.find((k) => k.tag === "img" || k.tag === "video" || k.tag === "picture");
  const mediaType: "image" | "video" | "none" = !anyMedia ? "none" : anyMedia.tag === "video" ? "video" : "image";
  const mediaPosition: "left" | "right" | "background" = bgMedia ? "background" : "left";
  const grid = groupSiblings(kids).find((g) => g.card === "N");
  return {
    mediaType,
    mediaPosition,
    align: "center", // refined from styles in Task 4/6; center is the neutral default
    itemCount: grid ? grid.reps.length : 1,
  };
}

/**
 * Extract a captured section's structure. Reuses tree.ts helpers only — this file adds NO new
 * tree-walking primitive. Returns the fields fingerprint() + the classifier consume.
 */
export function extractStructure(
  section: TreeEl,
  _styles: StyleMap,
  _role: TemplateSectionRole,
): { slotTree: SlotNode[]; layoutPrimitive: LayoutPrimitive; observed: HarvestedSection["observed"] } {
  return {
    slotTree: slotTreeOf(section),
    layoutPrimitive: layoutPrimitiveOf(section),
    observed: observeKnobs(section),
  };
}

// findTag is re-exported for the harvest pipeline's asset/media reads (keeps one import site).
export { findTag };
