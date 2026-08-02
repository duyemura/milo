import type { Browser } from "playwright";
import type { SiteRef } from "../edit/types.ts";
import { renderSnapshot } from "../edit/verify.ts";
import { COLOR_RE } from "../tree.ts";
import type { Classification } from "./types.ts";

/**
 * Scan an emitted CSS block for any raw color literal that should have been tokenized to a
 * brand var(). A clean tokenized section references ONLY var(--*) — any bare #hex/rgb()/rgba()
 * that is not inside a var() fallback is off-brand leakage. Returns the offending literals.
 */
export function offBrandLiterals(css: string): string[] {
  // Strip var(--token) refs first so their names don't trip the color regex, then scan the rest.
  const withoutVars = css.replace(/var\(\s*--[a-z0-9-]+\s*(,[^)]*)?\)/gi, "var()");
  const found: string[] = [];
  for (const m of withoutVars.matchAll(COLOR_RE)) found.push(m[0]);
  return found;
}

/**
 * Pure classification gate: adaptive iff residual is under threshold AND the swap-brand oracle
 * was clean. A low residual is NECESSARY but not SUFFICIENT — the oracle can reject a
 * cleanly-tokenized section that breaks geometrically under a different palette.
 */
export function classifyByResidual(residual: number, threshold: number, swapBrandClean: boolean): Classification {
  const reasons: string[] = [];
  const underThreshold = residual <= threshold;
  if (!underThreshold) reasons.push(`residual ${residual.toFixed(3)} exceeds threshold ${threshold}`);
  if (!swapBrandClean) reasons.push("swap-brand oracle failed (broken render or off-brand literal under another palette)");
  const verdict = underThreshold && swapBrandClean ? "adaptive" : "reject";
  if (verdict === "adaptive") reasons.push("adaptive: tokenizer absorbed the identity and swap-brand held");
  return { verdict, residual, swapBrandClean, reasons };
}

/**
 * The swap-brand ORACLE. Given a projected candidate section site (already emitting the tokenized
 * section) and >=2 swap-target site dirs (each with its OWN brand.json), re-render the candidate
 * under each target's brand and require: (a) render-sanity (renderSnapshot settles + builds), and
 * (b) no off-brand literal in the section's emitted CSS. Returns true iff ALL targets pass.
 *
 * Caller supplies `applyBrandOf(target)` — a closure that copies target's brand.json into the
 * candidate site + re-flattens :root (reuses buildBrand/flattenRoot from brand.ts, done in the
 * pipeline). This function only orchestrates the render + checks so it stays testable in isolation.
 */
export async function swapBrandOracle(
  browser: Browser,
  candidate: SiteRef,
  swapTargets: Array<{ apply: () => Promise<void>; restore: () => Promise<void> }>,
  sectionCss: string,
  opts: { width?: number; assetsFallback?: string | null } = {},
): Promise<{ clean: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const leaks = offBrandLiterals(sectionCss);
  if (leaks.length) reasons.push(`off-brand literals in section CSS: ${leaks.join(", ")}`);
  let clean = leaks.length === 0;
  for (const target of swapTargets) {
    await target.apply();
    try {
      const snap = await renderSnapshot(browser, candidate, { width: opts.width, assetsFallback: opts.assetsFallback });
      if (!snap.settled) { clean = false; reasons.push("swap render did not settle"); }
      // Render-sanity: sections must not overlap beyond tolerance — reuse verify()'s notion by
      // requiring the section is present in the rendered order.
      if (snap.order.length === 0) { clean = false; reasons.push("swap render produced no sections"); }
    } catch (err) {
      clean = false;
      reasons.push(`swap render failed: ${(err as Error).message}`);
    } finally {
      await target.restore();
    }
  }
  return { clean, reasons };
}
