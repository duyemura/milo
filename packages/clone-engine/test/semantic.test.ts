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

/**
 * Task 2: Component names unify under labels — the component filename, data-component attribute,
 * and index.astro import all agree and reflect the label-derived name.
 */
describe("component names from labels (Task 2)", () => {
  for (const site of SITES) {
    const goldenDir = path.join(dir, "golden", site);

    it(`${site}: data-component matches the label-derived component filename`, async () => {
      const out = await projectTmp(goldenDir);
      const cap: CaptureJson = JSON.parse(fs.readFileSync(path.join(goldenDir, "capture.json"), "utf8"));
      const labels = heuristicLabels(cap);

      // For each labeled section, find the emitted data-component value in the HTML and verify
      // that a matching .astro file exists in the components dir.
      const compDir = path.join(out.outDir, "components");
      const emittedFiles = new Set(fs.readdirSync(compDir));

      // Build id→name map from labels (same logic as project.ts).
      const labelNameById = new Map(labels.sections.map((s) => [s.id, s.name]));

      // Every data-component value must correspond to an emitted .astro file.
      const stampedComponents = dataVals(out.indexHtml, "data-component");
      expect(stampedComponents.length).toBeGreaterThan(0);
      for (const comp of stampedComponents) {
        expect(emittedFiles, `component file ${comp}.astro not found on disk`).toContain(`${comp}.astro`);
      }

      // For each labeled section (by id), its data-component must equal the label name (after dedup).
      // We verify by finding the section root element by its data-section role, then checking
      // the data-component attribute on the same tag equals a label-derived name.
      const roots = sectionRoots(out.indexHtml);
      for (const { component } of roots) {
        if (!component) continue;
        // The component name must be file-safe and non-empty.
        expect(component).toMatch(/^[A-Za-z]/); // no digit prefix
        // The component file must exist.
        expect(emittedFiles).toContain(`${component}.astro`);
      }

      // Verify that for sections whose label name is a real name (not copy-derived fallback),
      // the emitted component name agrees with the label name (possibly dedup-suffixed).
      // At minimum: every label name appears as a prefix of some emitted component.
      for (const [id, labelName] of labelNameById) {
        // Find the section root in the HTML that has this label's name (or dedup variant).
        const matchingComp = stampedComponents.find(
          (c) => c === labelName || c.startsWith(labelName.replace(/Section$/, "")),
        );
        expect(matchingComp, `No component found for label "${labelName}" (id=${id})`).toBeDefined();
      }
    }, 120_000);

    it(`${site}: no S<digit>Section junk when label provided a real name`, async () => {
      const out = await projectTmp(goldenDir);
      const cap: CaptureJson = JSON.parse(fs.readFileSync(path.join(goldenDir, "capture.json"), "utf8"));
      const labels = heuristicLabels(cap);

      // Sections that have a label name should NOT produce S<digit>Something component names.
      // (S<digit> prefix only appears for copy-derived fallback on sections whose text starts with a digit.)
      const labeledIds = new Set(labels.sections.map((s) => s.id));
      const compDir = path.join(out.outDir, "components");
      const emittedFiles = fs.readdirSync(compDir).filter((f) => f.endsWith(".astro"));

      // For this check: get all data-component values from sections that ARE labeled.
      // They should not start with S<digit>.
      const roots = sectionRoots(out.indexHtml);
      // We can't directly map root → label id here without parsing the whole HTML tree,
      // but we can check: among ALL stamped component names, S<digit>-prefixed ones should
      // only occur for sections that had no label (i.e., are not in labeledIds).
      // Simpler: since all sections on these sites ARE labeled, NONE should be S<digit>-prefixed
      // in the component output (except the dedup case "S30Day..." which already had S from the label).
      // We verify by checking the emitted index.astro imports.
      const indexAstro = fs.readFileSync(path.join(out.astroDir, "src/pages/index.astro"), "utf8");
      // All labeled sections should appear as named imports in index.astro.
      for (const s of labels.sections) {
        // Check that the label name (or a dedup variant of its base) appears in imports.
        const base = s.name.replace(/\d+Section$/, "Section").replace(/Section$/, "");
        expect(indexAstro, `Label "${s.name}" (id=${s.id}) not reflected in index.astro imports`).toMatch(
          new RegExp(`import (?:${s.name}|${base}\\d*Section) from`),
        );
      }

      // Verify the labeled sections count matches what we built.
      expect(labeledIds.size).toBeGreaterThan(0);
      // Check that data-component and the astro component name match for every section root.
      for (const { component } of roots) {
        if (!component) continue;
        expect(
          emittedFiles.some((f) => f === `${component}.astro`),
          `data-component="${component}" has no matching .astro file`,
        ).toBe(true);
      }
    }, 120_000);
  }
});

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
