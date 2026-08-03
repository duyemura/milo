import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import type { CheckResult, PageContext } from "../types.ts";
import type { PixelDiffResult } from "../../pixel.ts";
import { pixelDiff } from "../../pixel.ts";
import { renderSnapshot } from "../../edit/snapshot.ts";

/** Map a PixelDiffResult to a 0-100 fidelity percentage (100 = identical). */
export function computeFidelityPct(result: PixelDiffResult): number {
  return Math.max(0, Math.min(100, 100 - result.pct));
}

/**
 * Pixel-diff the built clone homepage against the source capture screenshot.
 * Returns a fidelity % as info (never a blocker — expected divergence from fallback fonts etc.).
 */
export async function checkFidelity(
  page: PageContext,
  browser: Browser,
  width: number,
): Promise<{ issues: CheckResult["issues"]; fidelityPct?: number }> {
  if (!page.source?.captureDir) return { issues: [] };
  const sourcePngPath = path.join(page.source.captureDir, "source-desktop.png");
  if (!fs.existsSync(sourcePngPath)) {
    return { issues: [{ severity: "info", page: page.route, kind: "fidelity-skip", detail: "source-desktop.png not found — fidelity check skipped" }] };
  }

  const snap = await renderSnapshot(browser, { dir: page.siteDir }, { width });
  const sourcePng = fs.readFileSync(sourcePngPath);
  const result = await pixelDiff(browser, sourcePng, snap.fullPng);
  const pct = computeFidelityPct(result);

  return {
    issues: [{ severity: "info", page: page.route, kind: "fidelity", detail: `Pixel fidelity vs source: ${pct.toFixed(1)}%` }],
    fidelityPct: pct,
  };
}
