/**
 * semantic.test.ts — data-* stamping is present + correct on the projected index.html.
 *
 * Task 1 (Plan 2): project() consumes labels and stamps render-neutral data-* attributes so an
 * LLM agent can address elements. These assertions verify the addressing contract; the 0-px
 * pixel oracle (parity-project.test.ts) verifies the stamping stayed render-neutral.
 *
 * Assertions per site (speakeasy + sweatshed — labels are strongest there):
 *  - [data-section] occurs at least once per content region (labels.sections),
 *  - every element carrying [data-section] also carries [data-component],
 *  - the labeled headline + primary-cta elements each carry a [data-role],
 *  - projection is deterministic (project() twice → identical indexHtml).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../src/project.ts";
import { heuristicLabels } from "../src/labels.ts";
import type { CaptureJson } from "../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["speakeasy", "sweatshed"] as const;

const tmpOutDirs: string[] = [];
afterAll(() => {
  for (const d of tmpOutDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function projectTmp(goldenDir: string) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-out-"));
  tmpOutDirs.push(out);
  return project({ dir: goldenDir, out, trim: true, noDiff: true });
}

/** All values of a given data-* attribute in the HTML (robust regex, order-preserving). */
function dataVals(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].map((m) => m[1]);
}

/** Every element that carries data-section, with the same element's data-component (or null). */
function sectionRoots(html: string): Array<{ section: string; component: string | null }> {
  // Match a start tag that contains data-section=… and capture the whole tag's attribute region.
  const out: Array<{ section: string; component: string | null }> = [];
  for (const m of html.matchAll(/<[a-zA-Z][^>]*\sdata-section="[^"]*"[^>]*>/g)) {
    const tag = m[0];
    const section = /\sdata-section="([^"]*)"/.exec(tag)?.[1] ?? "";
    const component = /\sdata-component="([^"]*)"/.exec(tag)?.[1] ?? null;
    out.push({ section, component });
  }
  return out;
}

describe("semantic data-* stamping", () => {
  for (const site of SITES) {
    const goldenDir = path.join(dir, "golden", site);

    it(`${site}: [data-section] on every content region, each with [data-component]`, async () => {
      const out = await projectTmp(goldenDir);
      const cap: CaptureJson = JSON.parse(fs.readFileSync(path.join(goldenDir, "capture.json"), "utf8"));
      const labels = heuristicLabels(cap);
      const contentRegions = labels.sections.length;
      expect(contentRegions).toBeGreaterThan(0);

      const roots = sectionRoots(out.indexHtml);
      // At least one data-section per labeled content region.
      expect(roots.length).toBeGreaterThanOrEqual(contentRegions);
      // Every section root also names its owning component.
      for (const r of roots) {
        expect(r.section.length).toBeGreaterThan(0);
        expect(r.component, `section "${r.section}" missing data-component`).not.toBeNull();
        expect((r.component ?? "").length).toBeGreaterThan(0);
      }
    }, 120_000);

    it(`${site}: labeled headline + primary-cta carry a data-role`, async () => {
      const out = await projectTmp(goldenDir);
      const cap: CaptureJson = JSON.parse(fs.readFileSync(path.join(goldenDir, "capture.json"), "utf8"));
      const labels = heuristicLabels(cap);
      const labeledRoles = new Set(labels.elements.map((e) => e.role));
      const stampedRoles = new Set(dataVals(out.indexHtml, "data-role"));

      // Both strong roles should be labeled by the heuristic on these sites…
      expect(labeledRoles).toContain("headline");
      expect(labeledRoles).toContain("primary-cta");
      // …and both should be stamped into the output.
      expect(stampedRoles).toContain("headline");
      expect(stampedRoles).toContain("primary-cta");
    }, 120_000);

    it(`${site}: projection is deterministic (identical indexHtml on re-run)`, async () => {
      const a = await projectTmp(goldenDir);
      const b = await projectTmp(goldenDir);
      expect(a.indexHtml).toEqual(b.indexHtml);
    }, 180_000);
  }
});
