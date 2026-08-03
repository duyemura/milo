// Offline calibration scan (run manually — hits the network). Sets the residual threshold +
// popularity floor empirically and validates the "~30-50 archetypes, not hundreds" thesis.
//
// Usage: cd packages/clone-engine && node --experimental-strip-types scripts/harvest-calibrate.mjs
//
// Captures are saved to scripts/harvest-captures/<slug>/ and reused on subsequent runs —
// re-scraping is skipped if capture.json already exists. Delete a slug's directory to force
// a fresh capture of that site.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { capture } from "../src/capture.ts";
import { harvestSites } from "../src/harvest/harvest.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(dir, "harvest-corpus.json"), "utf8"));

// Durable capture store — survives across runs. Committed to .gitignore (large files).
const CAPTURE_DIR = path.join(dir, "harvest-captures");
fs.mkdirSync(CAPTURE_DIR, { recursive: true });

const browser = await chromium.launch();
const captures = [];
for (const s of corpus.sites) {
  const siteDir = path.join(CAPTURE_DIR, s.slug);
  const capPath = path.join(siteDir, "capture.json");

  if (fs.existsSync(capPath)) {
    console.log(`reuse   ${s.slug}  (${capPath})`);
    captures.push({ site: s.slug, captureJson: capPath });
    continue;
  }

  fs.mkdirSync(siteDir, { recursive: true });
  try {
    const { capture: cap } = await capture({ url: s.url, out: siteDir });
    if (!fs.existsSync(capPath)) fs.writeFileSync(capPath, JSON.stringify(cap));
    captures.push({ site: s.slug, captureJson: capPath });
    console.log(`captured ${s.slug}`);
  } catch (e) {
    console.warn(`SKIP    ${s.slug}: ${e.message}`);
  }
}

// Sweep residual thresholds; report archetype count + swap-brand pass rate + popularity dist.
const THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
console.log("\nthreshold  adaptive%  archetypes  singletons  swapBrandCleanRate");
for (const t of THRESHOLDS) {
  const { library } = await harvestSites(browser, captures, { residualThreshold: t, popularityFloor: 1 });
  const rows = library.report;
  const adaptivePct = (100 * rows.filter((r) => r.verdict === "adaptive").length) / Math.max(1, rows.length);
  const archs = Object.values(library.archetypes);
  const singletons = archs.filter((a) => a.sites.length <= 1).length;
  const swapClean = (100 * rows.filter((r) => r.swapBrandClean).length) / Math.max(1, rows.length);
  console.log(
    `${t.toFixed(2)}       ${adaptivePct.toFixed(0)}%       ${archs.length}          ${singletons}           ${swapClean.toFixed(0)}%`,
  );
}

// Residual distribution (histogram) at threshold=1 (all candidates), for picking the cut.
const { library } = await harvestSites(browser, captures, { residualThreshold: 1, popularityFloor: 1 });
const residuals = library.report.map((r) => r.residual).sort((a, b) => a - b);
console.log("\nresidual distribution (deciles):");
for (let i = 0; i <= 10; i++) {
  const idx = Math.min(residuals.length - 1, Math.floor((i / 10) * residuals.length));
  console.log(`  p${i * 10}: ${(residuals[idx] ?? 0).toFixed(3)}`);
}
console.log(
  "\nRECOMMENDATION: set residualThreshold to the elbow where swapBrandCleanRate stays ~100% " +
    "and archetype count stabilizes (target tens, not hundreds). Set popularityFloor to 2 if " +
    "singletons dominate the noise. Record both in the E-v2 library config.",
);

await browser.close();
