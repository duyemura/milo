/**
 * verify.test.ts — NEGATIVE CONTROLS for the per-section internal-fidelity verifier.
 *
 * The verifier is the safety mechanism the whole edit subsystem rests on, so it MUST be
 * falsifiable: a clean edit passes AND a corrupting edit fails. These tests prove both,
 * over a REAL projected fixture built with the real Astro compiler.
 *
 *   1. Clean editCopy passes — edited section changed, all others outScopePx === 0.
 *   2. Corrupting edit FAILS — a visible change to an UNRELATED section, while the intent
 *      claims only the ORIGINAL section, produces outScopePx > 0 on the untouched section.
 *      THIS PROVES THE VERIFIER CAN FAIL.
 *   3. Reflow passes — removing a section reflows survivors; each survivor still verifies
 *      0-px internally (position-independent crops); the removed section is accounted for
 *      structurally.
 *   4. setBrand passes with the delta-vector — recolored pixels track the vector, collateral 0.
 *   5. swapAsset (INCLUDING a PNG→GIF type-change) passes — the image region changed, rest clean.
 *   6. failures[] carries an actionable string on the failing case.
 *
 * Each mutating test projects speakeasy to its OWN fresh temp dir (edits are destructive),
 * snapshots BEFORE, mutates, then verifies. A single browser is shared across all tests.
 * Anti-flake: the snapshot's bounded re-capture + decode-settle makes crops deterministic
 * even under concurrent browser load (a build-report job runs captures at the same time).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../src/project.ts";
import { editCopy, setBrand, styleTweak, swapAsset } from "../../src/edit/ops.ts";
import { verify, renderSnapshot, currentBrandHex, cropDiffPx as cropDiffPxForTest, type EditIntent } from "../../src/edit/verify.ts";
import { pixelDiff } from "../../src/pixel.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { SiteManifest } from "../../src/types.ts";
import { findAstroModules } from "../helpers/astro.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN = path.join(dir, "../golden/speakeasy");
const WIDTH = 1440;

const ASTRO_MODULES = findAstroModules();

/** A minimal valid GIF (43 bytes, 1×1) — a DIFFERENT type than the PNG logo (type-change path). */
const TINY_GIF_BUF = Buffer.from(
  "474946383961010001008000000000ffffff21f90401000000002c00000000010001000002024401003b",
  "hex",
);

/** Project speakeasy to a fresh temp dir. Each mutating test owns its own copy. */
async function projectFixture(): Promise<{ out: string; site: SiteRef; manifest: SiteManifest }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "edit-verify-"));
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  const site: SiteRef = { dir: out };
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
  return { out, site, manifest };
}

/** Remove a section from the projected artifact (index.astro import + tag, and site.json). */
function removeSectionInline(site: SiteRef, name: string): void {
  const idxPath = path.join(site.dir, "astro", "src", "pages", "index.astro");
  let idx = fs.readFileSync(idxPath, "utf8");
  // Drop the import line and the <Name /> tag.
  idx = idx
    .split("\n")
    .filter((l) => !new RegExp(`import ${name} from`).test(l))
    .filter((l) => l.trim() !== `<${name} />`)
    .join("\n");
  // A tag may sit inline rather than on its own line — strip it too.
  idx = idx.replace(new RegExp(`<${name} />`, "g"), "");
  fs.writeFileSync(idxPath, idx);

  const manifestPath = path.join(site.dir, "site.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SiteManifest;
  for (const page of manifest.pages) page.sections = page.sections.filter((s) => s.name !== name);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { if (browser) await browser.close(); });

const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("edit verifier — negative controls", () => {
  // 1. CLEAN editCopy → PASS, edited section changed, all others outScopePx === 0.
  it("clean editCopy passes: edited section changed, every other section 0-px", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);
    const before = await renderSnapshot(browser, site, { width: WIDTH });

    // Edit copy inside S3StepsToSection (a mid-page content section). Keep the sentinel short so
    // the copy element does NOT reflow the section (a same-height copy swap → element-box sub-scope).
    editCopy(site, "S3StepsToSection.6", "Edited step");
    const intent: EditIntent = {
      editedSections: ["S3StepsToSection"],
      op: { op: "editCopy", copyKey: "S3StepsToSection.6", text: "x" },
      // The edited copy element carries the key in its space-separated data-copy list.
      elementSelector: `[data-copy~="S3StepsToSection.6"]`,
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, `expected pass, got failures: ${report.failures.join(" | ")}`).toBe(true);
    expect(report.renderSane).toBe(true);
    expect(report.structural.ok).toBe(true);

    const edited = report.sections.find((s) => s.section === "S3StepsToSection")!;
    expect(edited.changed, "the edited section must show a change").toBe(true);
    expect(edited.inScopePx, "the change must land inside the edited element box").toBeGreaterThan(0);
    expect(edited.outScopePx, "no intra-section collateral outside the element box").toBe(0);

    // Every OTHER section is internally clean.
    for (const s of report.sections) {
      if (s.section === "S3StepsToSection") continue;
      expect(s.outScopePx, `section ${s.section} leaked ${s.outScopePx}px out of scope`).toBe(0);
    }
  }, 300_000);

  // 2. CORRUPTING edit → FAIL. Change an UNRELATED section, claim the edit targeted only the
  //    ORIGINAL section → outScopePx > 0 on the untouched section. THIS PROVES THE VERIFIER FAILS.
  it("corrupting edit FAILS: unrelated section change is caught as out-of-scope", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);
    const before = await renderSnapshot(browser, site, { width: WIDTH });

    // Corrupt an UNRELATED section: paint StoriesOfGlorySection's background bright red.
    styleTweak(site, "StoriesOfGlorySection", "background-color", "#ff0000");

    // ...but claim the edit only targeted a DIFFERENT section (ExploreProgramsAtSection).
    const intent: EditIntent = {
      editedSections: ["ExploreProgramsAtSection"],
      op: { op: "styleTweak", target: "ExploreProgramsAtSection", prop: "background-color", value: "#ff0000" },
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, "a corrupting edit MUST make the verifier fail").toBe(false);
    const leaked = report.sections.find((s) => s.section === "StoriesOfGlorySection")!;
    expect(leaked.outScopePx, "the corrupted untouched section must report out-of-scope pixels").toBeGreaterThan(0);
    // 6. failures[] must carry an actionable string naming the section + px.
    expect(report.failures.some((f) => /StoriesOfGlorySection/.test(f) && /outside the edited target/.test(f))).toBe(true);
  }, 300_000);

  // 3. REFLOW passes: remove a section; survivors reflow but still verify 0-px internally.
  it("reflow passes: removing a section keeps survivors internally 0-px (position-independent)", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);
    const before = await renderSnapshot(browser, site, { width: WIDTH });

    const REMOVED = "ProgramsSection";
    removeSectionInline(site, REMOVED);
    const intent: EditIntent = { editedSections: [REMOVED], op: { op: "removeSection", section: REMOVED } };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, `expected reflow pass, failures: ${report.failures.join(" | ")}`).toBe(true);
    expect(report.structural.ok, "removed section must be accounted for structurally").toBe(true);
    expect(report.structural.actual).not.toContain(REMOVED);
    // Sections BELOW the removed one shifted up, yet each survivor still verifies 0-px internally.
    for (const s of report.sections) {
      expect(s.outScopePx, `survivor ${s.section} leaked ${s.outScopePx}px after reflow`).toBe(0);
    }
  }, 300_000);

  // 4. setBrand passes with the delta-vector: recolor tracked, collateral 0.
  it("setBrand passes: recolor tracks the delta-vector, non-brand collateral is clean", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);
    const before = await renderSnapshot(browser, site, { width: WIDTH });

    const oldHex = currentBrandHex(site, "primary"); // "#ec008c"
    const newHex = "#1e40af"; // a strong blue — a clear directional recolor from magenta
    setBrand(site, "primary", newHex);
    const intent: EditIntent = {
      editedSections: [],
      op: { op: "setBrand", slot: "primary", value: newHex },
      brandRecolor: { oldHex, newHex },
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, `expected setBrand pass, failures: ${report.failures.join(" | ")}`).toBe(true);
    const brand = report.sections.find((s) => s.section === "(brand)")!;
    expect(brand.inScopePx, "the recolor must land some pixels along the delta-vector").toBeGreaterThan(0);
    expect(brand.outScopePx, "no collateral outside the recolor vector").toBe(0);
  }, 300_000);

  // 4b. T1 — setBrand NEGATIVE control: the setBrand verify branch MUST be falsifiable. Paint an
  //     UNRELATED section bright red (collateral that does NOT track the recolor delta-vector), then
  //     verify with a setBrand intent + brandRecolor at the primary slot. The red is off-vector, so
  //     it lands in outScope → pass MUST be false. (Test 4 only proves the PASS path; this proves the
  //     setBrand branch CAN fail — a real recolor with unrelated collateral is caught.)
  it("setBrand FAILS when unrelated collateral doesn't track the recolor delta-vector (negative control)", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);
    const before = await renderSnapshot(browser, site, { width: WIDTH });

    const oldHex = currentBrandHex(site, "primary"); // "#ec008c"
    const newHex = "#1e40af"; // a strong blue — the intended recolor vector (magenta → blue)

    // Do the real recolor AND introduce off-vector collateral: paint an unrelated section red.
    // Red is not on the magenta→blue delta-vector, so it is collateral the verifier must catch.
    setBrand(site, "primary", newHex);
    styleTweak(site, "StoriesOfGlorySection", "background-color", "#ff0000");

    const intent: EditIntent = {
      editedSections: [],
      op: { op: "setBrand", slot: "primary", value: newHex },
      brandRecolor: { oldHex, newHex },
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, "off-vector collateral during a recolor MUST fail the setBrand branch").toBe(false);
    const brand = report.sections.find((s) => s.section === "(brand)")!;
    expect(brand.outScopePx, "the red collateral must land outside the recolor vector (outScope > 0)").toBeGreaterThan(0);
  }, 300_000);

  // 5. swapAsset (PNG → GIF type-change) passes: image region changed, rest clean.
  it("swapAsset passes with a PNG→GIF type-change: image region changed, other sections clean", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);
    const before = await renderSnapshot(browser, site, { width: WIDTH });

    // Source the new logo as a GIF (different type than the PNG) → exercises the type-change path.
    const gifSrc = path.join(out, "new-logo.gif");
    fs.writeFileSync(gifSrc, TINY_GIF_BUF);
    const result = await swapAsset(site, "logo", gifSrc);
    // The type changed → the filename/refs were rewritten; the owning section is the logo's.
    expect(result.op.op).toBe("swapAsset");

    // The logo lives in Navbar; that section is the edited target.
    const intent: EditIntent = {
      editedSections: result.targetSections.length ? result.targetSections : ["Navbar"],
      op: { op: "swapAsset", alias: "logo", source: gifSrc },
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, `expected swapAsset pass, failures: ${report.failures.join(" | ")}`).toBe(true);
    const target = intent.editedSections[0];
    const edited = report.sections.find((s) => s.section === target)!;
    expect(edited.changed, "the image region must have changed").toBe(true);
    for (const s of report.sections) {
      if (intent.editedSections.includes(s.section)) continue;
      expect(s.outScopePx, `section ${s.section} leaked ${s.outScopePx}px after asset swap`).toBe(0);
    }
  }, 300_000);

  // 6. CRITICAL negative control — a DIMENSION change of an UNTOUCHED section must FAIL.
  //    pixelDiff only compares the top-left overlap band, so a corruption that grows a section's
  //    height would diff clean on the shared band and silently PASS without the dimMatch hard-fail.
  //    Here we grow StoriesOfGlorySection's height (top padding) while claiming the edit targeted a
  //    DIFFERENT section → the untouched section's crop changes DIMENSIONS → outScopePx > 0 → FAIL.
  it("dimension-change corruption of an untouched section FAILS (guards the overlap-band false-pass)", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);
    const before = await renderSnapshot(browser, site, { width: WIDTH });

    // Grow the untouched section's height (padding reliably grows the integer crop height).
    styleTweak(site, "StoriesOfGlorySection", "padding", "120px");

    // ...but claim the edit only targeted a DIFFERENT section.
    const intent: EditIntent = {
      editedSections: ["ExploreProgramsAtSection"],
      op: { op: "styleTweak", target: "ExploreProgramsAtSection", prop: "padding", value: "120px" },
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, "a dimension change of an untouched section MUST make the verifier fail").toBe(false);
    const grown = report.sections.find((s) => s.section === "StoriesOfGlorySection")!;
    expect(grown.outScopePx, "the grown untouched section must report out-of-scope pixels").toBeGreaterThan(0);
    // The failure is actionable and names the untouched section that changed out of scope.
    expect(
      report.failures.some((f) => /StoriesOfGlorySection/.test(f) && /outside the edited target/.test(f)),
      `expected an out-of-scope failure naming the section, got: ${report.failures.join(" | ")}`,
    ).toBe(true);
  }, 300_000);

  // 7. UNIT proof of the dimension-mismatch guard in isolation — the exact false-pass the review
  //    reproduced: two crops that are BYTE-IDENTICAL on the shared top-left band but differ in
  //    HEIGHT (100×100 vs 100×200) → pixelDiff reports d=0 on the band, but cropDiffPx must treat
  //    the dimension change as a full internal change so the verifier hard-fails. This proves the
  //    guard directly, without depending on a corruption that also shifts shared-band content.
  it("cropDiffPx hard-fails on a pure dimension change (100×100 vs 100×200, identical shared band)", async () => {
    // Build two solid-red PNGs where B is taller (extra rows appended at the bottom, so the
    // overlapping 100×100 band is byte-identical). pixelDiff alone → d=0, dimMatch=false.
    const mkPng = async (w: number, h: number): Promise<Buffer> => {
      const p = await browser.newPage();
      try {
        const b64 = await p.evaluate(([ww, hh]) => {
          const cv = document.createElement("canvas");
          cv.width = ww as number; cv.height = hh as number;
          const ctx = cv.getContext("2d")!;
          ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, ww as number, hh as number);
          return cv.toDataURL("image/png").split(",")[1];
        }, [w, h] as const);
        return Buffer.from(b64, "base64");
      } finally { await p.close(); }
    };
    const a = await mkPng(100, 100);
    const b = await mkPng(100, 200);

    // Sanity: the raw oracle sees ZERO diff on the shared band but a dimension mismatch.
    const raw = await pixelDiff(browser, a, b);
    expect(raw.d, "raw pixelDiff must report 0 on the identical shared band").toBe(0);
    expect(raw.dimMatch, "the crops must differ in dimensions").toBe(false);

    // The guarded diff must NOT report 0 — the dimension change is a real internal change.
    const guarded = await cropDiffPxForTest(browser, a, b);
    expect(guarded.dimChanged, "the guard must flag the dimension change").toBe(true);
    expect(guarded.px, "the guard must report changed pixels, not a false 0").toBeGreaterThan(0);
  }, 120_000);
});
