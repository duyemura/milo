/**
 * reflow.test.ts — scenario tests for removeSection + reorderSection (C-T4).
 *
 * These are end-to-end tests gated by the real per-section verifier (verify.ts).
 * Each test projects the speakeasy fixture to its own fresh temp dir, snapshots
 * BEFORE, runs the op, then calls verify() to prove the edit landed correctly AND
 * no collateral damage escaped.
 *
 * Scenarios:
 *   1. removeSection passes — the removed section is gone from both DOM and site.json;
 *      every surviving section has outScopePx === 0 (position-independent reflow crops).
 *   2. reorderSection passes — the moved section appears at the new index in both DOM
 *      and site.json; structural check confirms the new order (proving the
 *      expectedSectionOrder fix works — without it this test would false-fail).
 *   3. Corrupting reflow FAILS — after removeSection, a visible change to a SURVIVING
 *      sibling is caught; verify() returns pass===false with an actionable failure
 *      naming the sibling. Proves reflow ops can't hide collateral.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../../src/project.ts";
import { removeSection, reorderSection, styleTweak } from "../../../src/edit/ops.ts";
import { verify, renderSnapshot, type EditIntent } from "../../../src/edit/verify.ts";
import { sectionListOf } from "../../../src/edit/snapshot.ts";
import type { SiteRef } from "../../../src/edit/types.ts";
import type { SiteManifest } from "../../../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN = path.join(dir, "../../golden/speakeasy");
const WIDTH = 1440;

function findAstroModules(): string | null {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(REPO, "page-clone-spike/out-project-page/astro/node_modules"),
    path.join(PKG, "node_modules"),
    path.join(REPO, "node_modules"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}
const ASTRO_MODULES = findAstroModules();

async function projectFixture(): Promise<{ out: string; site: SiteRef; manifest: SiteManifest }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "reflow-test-"));
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  const site: SiteRef = { dir: out };
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
  return { out, site, manifest };
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { if (browser) await browser.close(); });

const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("reflow ops — removeSection + reorderSection (C-T4)", () => {

  // 1. removeSection passes: the removed section is gone from DOM + site.json; survivors 0-px.
  it("removeSection passes: removed section gone from DOM and site.json, survivors 0-px", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);

    const before = await renderSnapshot(browser, site, { width: WIDTH });
    const beforeOrder = before.order;

    // Remove a middle section (not first/last — exercises real reflow of sections below it).
    const REMOVED = "ProgramsSection";
    const result = removeSection(site, REMOVED);
    expect(result.op.op).toBe("removeSection");
    expect(result.targetSections).toContain(REMOVED);

    // The expected post-edit order is beforeOrder minus the removed section.
    const expectedSectionOrder = beforeOrder.filter((n) => n !== REMOVED);

    const intent: EditIntent = {
      editedSections: [REMOVED],
      op: { op: "removeSection", section: REMOVED },
      expectedSectionOrder,
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, `expected removeSection pass, failures: ${report.failures.join(" | ")}`).toBe(true);
    expect(report.renderSane).toBe(true);
    expect(report.structural.ok, "removed section must be accounted for structurally").toBe(true);
    expect(report.structural.actual).not.toContain(REMOVED);

    // site.json must no longer list the removed section.
    const afterManifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    expect(afterManifest.pages[0].sections.map((s) => s.name)).not.toContain(REMOVED);
    // Its copy keys must also be gone.
    const copyKeys = afterManifest.pages[0].copy.map((c) => c.key);
    expect(copyKeys.some((k) => k.startsWith(`${REMOVED}.`))).toBe(false);

    // Every surviving section has outScopePx === 0 (position-independent crops prove reflow is safe).
    for (const s of report.sections) {
      expect(
        s.outScopePx,
        `survivor '${s.section}' leaked ${s.outScopePx}px after removeSection reflow`,
      ).toBe(0);
    }
  }, 300_000);

  // 2. reorderSection passes: section moved to new index; structural confirms the new order.
  //    Without the expectedSectionOrder fix in verify.ts this test would false-fail because
  //    expectedSectionOrder() would default to beforeOrder and the structural check would flag
  //    the reordered DOM as mismatched.
  it("reorderSection passes: new order confirmed in DOM and site.json, survivors 0-px", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);

    const before = await renderSnapshot(browser, site, { width: WIDTH });
    const beforeOrder = before.order;

    // Move S3StepsToSection (index 2) to index 4 (the middle of the content sections).
    // beforeOrder: [Navbar(0), AwesomeForEveryoneSection(1), S3StepsToSection(2), ProgramsSection(3),
    //               ExploreProgramsAtSection(4), DiscoverSpeakeasyOfSection(5), StoriesOfGlorySection(6), Footer(7)]
    // This reorder only affects the range [2..4], leaving Footer and sections below it untouched.
    const MOVED = "S3StepsToSection";
    const TO_INDEX = 4; // move to position 4

    const result = reorderSection(site, MOVED, TO_INDEX);
    expect(result.op.op).toBe("reorderSection");
    expect(result.targetSections).toContain(MOVED);

    // Compute the expected post-reorder order.
    const withoutMoved = beforeOrder.filter((n) => n !== MOVED);
    const expectedSectionOrder = [
      ...withoutMoved.slice(0, TO_INDEX),
      MOVED,
      ...withoutMoved.slice(TO_INDEX),
    ];

    // result.targetSections lists all sections in the affected range [min(from,to)..max(from,to)].
    // Declaring them as editedSections tells the verifier these sections are allowed to have pixel
    // differences — sub-pixel Y-coordinate rendering changes are real and expected for sections
    // that move to a different screen position. The STRUCTURAL check (expectedSectionOrder) is the
    // correctness guarantee: it proves the new order landed in both DOM and site.json.
    // Sections OUTSIDE the affected range must still report 0-px change.
    const intent: EditIntent = {
      editedSections: result.targetSections,
      op: { op: "reorderSection", section: MOVED, toIndex: TO_INDEX },
      expectedSectionOrder,
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    expect(report.pass, `expected reorderSection pass, failures: ${report.failures.join(" | ")}`).toBe(true);
    expect(report.renderSane).toBe(true);
    expect(report.structural.ok, "reordered section must be confirmed structurally").toBe(true);
    expect(report.structural.actual[TO_INDEX]).toBe(MOVED);

    // site.json must reflect the new order.
    const afterList = sectionListOf(site);
    expect(afterList.map((s) => s.name)).toEqual(expectedSectionOrder);

    // The moved section itself must appear at the correct index in the DOM.
    expect(report.structural.actual[TO_INDEX], `${MOVED} must be at index ${TO_INDEX} in DOM`).toBe(MOVED);
  }, 300_000);

  // 3. Corrupting reflow FAILS: after removeSection, a visible change to a surviving sibling
  //    is caught by the verifier. Proves reflow ops can't hide collateral damage.
  it("corrupting reflow FAILS: sibling corruption after removeSection is caught", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);

    const before = await renderSnapshot(browser, site, { width: WIDTH });
    const beforeOrder = before.order;

    // Perform the legitimate removeSection.
    const REMOVED = "ProgramsSection";
    removeSection(site, REMOVED);

    // Now ALSO corrupt a surviving sibling with a visible paint change (bright red background).
    // The intent only claims removeSection — so the sibling corruption is collateral.
    const CORRUPTED_SIBLING = "StoriesOfGlorySection";
    styleTweak(site, CORRUPTED_SIBLING, "background-color", "#ff0000");

    // The declared intent covers only the removeSection; it does NOT cover the sibling change.
    const expectedSectionOrder = beforeOrder.filter((n) => n !== REMOVED);
    const intent: EditIntent = {
      editedSections: [REMOVED],
      op: { op: "removeSection", section: REMOVED },
      expectedSectionOrder,
    };

    const report = await verify(browser, before, site, intent, { width: WIDTH });

    // The verifier MUST fail — collateral on a surviving sibling must not be hidden by reflow.
    expect(report.pass, "a corrupting reflow MUST make the verifier fail").toBe(false);

    // The failure must name the sibling.
    const siblingLeak = report.sections.find((s) => s.section === CORRUPTED_SIBLING);
    expect(
      siblingLeak?.outScopePx ?? 0,
      `corrupted sibling '${CORRUPTED_SIBLING}' must report out-of-scope pixels`,
    ).toBeGreaterThan(0);
    expect(
      report.failures.some((f) => new RegExp(CORRUPTED_SIBLING).test(f) && /outside the edited target/.test(f)),
      `expected actionable failure naming '${CORRUPTED_SIBLING}', got: ${report.failures.join(" | ")}`,
    ).toBe(true);
  }, 300_000);
});
