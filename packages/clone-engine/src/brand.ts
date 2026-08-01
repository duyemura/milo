/**
 * brand.ts — global brand document (`brand.json`) + canonical token cascade (Plan 2, Task 3).
 *
 * The clone engine already tokenizes every distinct color literal to a `var(--<name>)`
 * whose value is that EXACT captured literal (byte-preserving — the source of the 0-px
 * projection). This module does NOT re-tokenize. It:
 *   1. Renames the tokens that correspond to a labeled BRAND SLOT to canonical
 *      `--color-<slot>` names, and their opacity/tint variants to `--color-<slot>-<NN>`.
 *   2. Emits a `BrandDoc` (mirrors `@milo/schema`'s `BrandTokens`) so the brand is
 *      editable from one place.
 *
 * BYTE-PRESERVATION INVARIANT (the coupling gate): a literal rewritten to
 * `var(--color-<slot>)` MUST resolve to the identical bytes it had before. We enforce
 * this by keying the cascade on the canonical color and using the EXACT captured repr
 * as each token's CSS value. A slot/variant is only ever mapped from a literal whose
 * canon equals the slot/variant canon, and there is exactly one captured repr per canon
 * (computed styles are normalized by the browser), so the mapping is lossless.
 */
import type { CaptureJson, Labels, BrandDoc } from "./types.ts";
// Color canonicalizer lives in tree.ts (shared with labels.ts / project.ts). Re-export
// so existing importers of `brand.canon` keep working.
export { canon } from "./tree.ts";

/** A canonical "r,g,b,a" → `#rrggbb` (opaque form, drops alpha — for the editable brand doc). */
function canonToHex(canonStr: string): string {
  const [r, g, b] = canonStr.split(",").map(Number);
  return "#" + [r, g, b].map((n) => (n & 255).toString(16).padStart(2, "0")).join("");
}

/** Alpha (0..1) of a canonical color. */
function canonAlpha(canonStr: string): number {
  const parts = canonStr.split(",");
  return parts[3] === undefined ? 1 : Number(parts[3]);
}

/** The "r,g,b" prefix (ignoring alpha) of a canonical color. */
function rgbPrefix(canonStr: string): string {
  const [r, g, b] = canonStr.split(",");
  return `${r},${g},${b},`;
}

const BRAND_COLOR_ORDER = ["primary", "accent", "surface", "text", "muted"] as const;

/** Look up a slot's canon in the labels (or undefined if the labeler didn't assign it). */
function slotCanon(labels: Labels, slot: string): string | undefined {
  return labels.brand.colors.find((c) => c.slot === slot)?.canon;
}

/** Look up a font slot's family (or undefined). */
function fontFamily(labels: Labels, slot: string): string | undefined {
  return labels.brand.fonts.find((f) => f.slot === slot)?.family;
}

/**
 * Build the editable brand document in `BrandTokens` shape.
 * Colors resolve each labeled slot's canon → `#rrggbb`; a slot the labeler didn't
 * assign falls back to a sensible neutral so the doc always type-checks. Fonts fall
 * back body→display when the labeler found only one family. space/radius are defaults.
 */
export function buildBrand(labels: Labels, _cap: CaptureJson): BrandDoc {
  const hexOf = (slot: string, fallback: string): string => {
    const c = slotCanon(labels, slot);
    return c ? canonToHex(c) : fallback;
  };
  const display = fontFamily(labels, "display") ?? "sans-serif";
  const body = fontFamily(labels, "body") ?? display;
  return {
    colors: {
      primary: hexOf("primary", "#000000"),
      accent: hexOf("accent", "#000000"),
      surface: hexOf("surface", "#ffffff"),
      text: hexOf("text", "#111111"),
      muted: hexOf("muted", "#888888"),
    },
    fonts: { display, body },
    space: { sm: "8px", md: "16px", lg: "32px" },
    radius: { button: "6px", card: "12px" },
  };
}

/**
 * Map each BASE brand-slot canon → its canonical `--color-<slot>` var name.
 * Only slots the labeler actually assigned are included (so project.ts only rewrites
 * literals it can prove belong to a slot).
 */
export function brandSlotOfCanon(labels: Labels): Map<string, string> {
  const m = new Map<string, string>();
  for (const slot of BRAND_COLOR_ORDER) {
    const c = slotCanon(labels, slot);
    if (c) m.set(c, `--color-${slot}`);
  }
  return m;
}

/**
 * For each brand slot, find the canonical colors that share the slot's r,g,b but at a
 * DIFFERENT alpha (opacity variants) among the colors actually used in the styles, and
 * assign each a derived token `--color-<slot>-<NN>` (NN = round(alpha*100)).
 *
 * `usedCanons` is the set of canonical colors present in the styles (project.ts already
 * collects these). Returns canon → `--color-<slot>-<NN>`. The token's VALUE is emitted by
 * `flattenRoot` from the exact captured repr, so it is byte-identical to the literal it
 * replaces.
 */
export function deriveVariants(labels: Labels, usedCanons: Iterable<string>): Map<string, string> {
  const used = [...new Set(usedCanons)];
  const out = new Map<string, string>();
  const seenNames = new Set<string>();
  for (const slot of BRAND_COLOR_ORDER) {
    const baseCanon = slotCanon(labels, slot);
    if (!baseCanon) continue;
    const prefix = rgbPrefix(baseCanon);
    // deterministic order: by alpha ascending
    const variants = used
      .filter((c) => c.startsWith(prefix) && c !== baseCanon)
      .sort((a, b) => canonAlpha(a) - canonAlpha(b));
    for (const c of variants) {
      const nn = Math.round(canonAlpha(c) * 100);
      let name = `--color-${slot}-${nn}`;
      // guard against two variants rounding to the same NN (keep both, disambiguate)
      if (seenNames.has(name)) { let i = 2; while (seenNames.has(`${name}-${i}`)) i++; name = `${name}-${i}`; }
      seenNames.add(name);
      out.set(c, name);
    }
  }
  return out;
}

/**
 * Flatten the brand + derived variants into a `:root` block of canonical custom
 * properties. Base slot colors and variants use the EXACT captured repr (byte-preserving);
 * fonts/space/radius come from the brand doc.
 *
 * @param reprOfCanon canon → exact captured literal (so `--color-<slot>` resolves to the
 *        identical bytes the literal had). Required for every canon in `variants` and for
 *        every assigned slot; a slot whose canon has no captured repr (labeler-only) uses
 *        the brand-doc hex as a best-effort fallback.
 * @param extra additional `  --name: value;` lines to emit INSIDE the same `:root` block
 *        (e.g. the non-brand leftover per-literal tokens) — keeps all custom properties in
 *        one valid rule.
 */
export function flattenRoot(
  labels: Labels,
  brand: BrandDoc,
  variants: Map<string, string>,
  reprOfCanon: Map<string, string>,
  extra: string[] = [],
): string {
  const lines: string[] = [];
  // Base slot colors — byte-exact repr when the slot's canon was actually captured.
  for (const slot of BRAND_COLOR_ORDER) {
    const c = slotCanon(labels, slot);
    const value = (c && reprOfCanon.get(c)) ?? brand.colors[slot];
    lines.push(`  --color-${slot}: ${value};`);
  }
  // Fonts.
  lines.push(`  --font-display: ${brand.fonts.display};`);
  lines.push(`  --font-body: ${brand.fonts.body};`);
  // Space + radius (from the editable brand doc / defaults).
  for (const [k, v] of Object.entries(brand.space)) lines.push(`  --space-${k}: ${v};`);
  for (const [k, v] of Object.entries(brand.radius)) lines.push(`  --radius-${k}: ${v};`);
  // Derived opacity/tint variants — byte-exact captured repr (this is the coupling guard).
  for (const [c, name] of variants) {
    const repr = reprOfCanon.get(c);
    if (repr) lines.push(`  ${name}: ${repr};`);
  }
  // Non-brand leftover tokens (already formatted as `  --name: value;`).
  for (const l of extra) if (l.trim()) lines.push(l);
  return `:root {\n${lines.join("\n")}\n}`;
}
