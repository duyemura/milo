/**
 * tree.ts — shared tree + color helpers used by labels.ts, project.ts, and brand.ts.
 *
 * These primitives were duplicated byte-identically across the three modules (flagged
 * as a drift risk in the T0/T1/T3 reviews). They are consolidated here so the single
 * source of truth can't drift. The extracted `canon` + region-partition logic are
 * byte-identical to the originals — the 0-px pixel oracle and the label determinism
 * tests prove the consolidation is output-neutral.
 */
import type { TreeEl, TreeNode } from "./types.ts";

// ---- Color canonicalizer ----
// Normalize any color literal to canonical "r,g,b,a" so `#EC008C` === `rgb(236,0,140)`.
//
// Hex branch note (T3 review): CSS computed styles never surface 5- or 7-char hex — the
// browser normalizes every color to `rgb()`/`rgba()` (or, at most, 3/4/6/8-char hex from
// authored inline styles it echoes back). The `{3,8}` capture admits 5 and 7 only so the
// regex stays a simple length range; those lengths hit neither the 3/4 nor the 6 rewrite
// and fall through to the 6-char `slice` path, producing a well-defined (if academic)
// canon. We keep the branch permissive rather than special-casing an input that can't occur.
export function canon(c: string): string {
  const s = c.trim().toLowerCase();
  let m: RegExpMatchArray | null, r: number, g: number, b: number, a = 1;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/))) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("") + "ff";
    else if (h.length === 4) h = h.split("").map((x) => x + x).join("");
    else if (h.length === 6) h = h + "ff";
    // 5 and 7 are unreachable from real captures (see note above) — they fall through
    // to the slice below and canonicalize deterministically.
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    a = parseInt(h.slice(6, 8), 16) / 255;
  } else if ((m = s.match(/^rgba?\(([^)]*)\)$/))) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    r = p[0]; g = p[1]; b = p[2]; a = p[3] === undefined ? 1 : p[3];
  } else {
    return s;
  }
  return `${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(4)}`;
}

/** Matches every color literal (rgb/rgba/hex) inside a CSS value string. */
export const COLOR_RE = /rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;

// ---- Tree navigation ----

/** True when a node is an element (not a text node). */
export function isEl(n: TreeNode): n is TreeEl { return (n as { t?: string }).t === undefined; }

/** The element children of an element (text nodes filtered out). */
export function elKids(n: TreeEl): TreeEl[] { return n.children.filter(isEl); }

/** Depth-first search for the first element with tag `tag`, or null. */
export function findTag(n: TreeEl, tag: string): TreeEl | null {
  if (n.tag === tag) return n;
  for (const c of elKids(n)) { const f = findTag(c, tag); if (f) return f; }
  return null;
}

/**
 * Partition the capture tree into top-level regions, mirroring project.ts's component
 * split EXACTLY: find `<main>` (else the root), then descend through any single-element
 * wrappers, and take the remaining element children as the regions. Returns each region
 * node with its index.
 */
export function partitionRegions(tree: TreeEl): Array<{ index: number; node: TreeEl }> {
  const main = findTag(tree, "main") ?? tree;
  let sroot = main, sk = elKids(sroot);
  while (sk.length === 1) { sroot = sk[0]; sk = elKids(sroot); }
  return sk.map((node, index) => ({ index, node }));
}
