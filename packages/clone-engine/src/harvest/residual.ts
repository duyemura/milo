import type { StyleMap } from "../types.ts";
import { canon, COLOR_RE } from "../tree.ts";

/** Props whose mere presence is bespoke, identity-bearing art the tokenizer cannot absorb. */
export const BESPOKE_PROPS = [
  "background-image",
  "clip-path",
  "-webkit-clip-path",
  "mask",
  "mask-image",
  "filter",
  "backdrop-filter",
  "mix-blend-mode",
] as const;

const BESPOKE_SET = new Set<string>(BESPOKE_PROPS);
const COLOR_PROPS = new Set([
  "color", "background-color", "border-color", "border-top-color", "border-bottom-color",
  "border-left-color", "border-right-color", "outline-color", "fill", "stroke",
]);
const TRANSPARENT = new Set(["0,0,0,0", "255,255,255,0"]);

/**
 * Residual bespoke-styling score in [0,1]: the fraction of "identity-bearing" style
 * observations that did NOT reduce to a brand token after tokenization.
 *
 * Observation set = every bespoke-prop occurrence (each counts as residual) PLUS every
 * color-prop occurrence (residual iff its canon is not a brand-slot canon). The score is
 * residual observations / total identity observations. A section whose look lives entirely
 * in brand tokens scores ~0; one leaning on background art / off-palette literals scores high.
 *
 * @param styles      the section's captured 1440 StyleMap (id -> prop -> value).
 * @param brandCanons the canon strings the tokenizer maps to a brand slot (absorbed = not residual).
 */
export function residualScore(styles: StyleMap, brandCanons: Set<string>): number {
  let total = 0;
  let residual = 0;
  for (const id in styles) {
    const props = styles[id];
    for (const [prop, value] of Object.entries(props)) {
      if (BESPOKE_SET.has(prop)) {
        // background-image:none / gradients with only brand colors are not bespoke art.
        if (prop === "background-image" && /^none$/i.test(value.trim())) continue;
        total += 1;
        residual += 1;
        continue;
      }
      if (COLOR_PROPS.has(prop) || prop === "box-shadow") {
        for (const m of value.matchAll(COLOR_RE)) {
          const c = canon(m[0]);
          if (TRANSPARENT.has(c)) continue;
          total += 1;
          if (!brandCanons.has(c)) residual += 1;
        }
      }
    }
  }
  if (total === 0) return 0;
  return residual / total;
}
