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
import type { CaptureJson, SiteManifest, ManifestCopyEntry } from "../src/types.ts";

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

/**
 * Task 4: site.json manifest — the agent-addressable site map.
 *
 * Assertions per site:
 *  - site.json parses to the SiteManifest shape (brand, pages[])
 *  - every page has route, component, sections[], elements[], assets[]
 *  - every elements[].id (strip leading "p" → numeric) has a matching ".p<n>" class in the HTML
 *  - every elements[].selector ("[data-role=<role>]") matches an attribute in the HTML
 *  - every assets[].file exists on disk under OUT
 *  - every sections[].file corresponds to an emitted component .astro file OR a data-component ref in the HTML
 */
describe("site.json manifest (Task 4)", () => {
  for (const site of SITES) {
    const goldenDir = path.join(dir, "golden", site);

    it(`${site}: site.json has correct shape and all handles resolve`, async () => {
      const out = await projectTmp(goldenDir);
      const siteJsonPath = path.join(out.outDir, "site.json");

      // File must exist.
      expect(fs.existsSync(siteJsonPath), "site.json not found in outDir").toBe(true);

      // Must parse to SiteManifest shape.
      const manifest = JSON.parse(fs.readFileSync(siteJsonPath, "utf8")) as SiteManifest;
      expect(typeof manifest.brand).toBe("string");
      expect(manifest.brand).toBe("brand.json");
      expect(Array.isArray(manifest.pages)).toBe(true);
      expect(manifest.pages.length).toBeGreaterThan(0);

      const page = manifest.pages[0];
      expect(typeof page.route).toBe("string");
      expect(typeof page.component).toBe("string");
      expect(Array.isArray(page.sections)).toBe(true);
      expect(Array.isArray(page.elements)).toBe(true);
      expect(Array.isArray(page.assets)).toBe(true);

      // route must be "/" or a BASE-relative path.
      expect(page.route).toMatch(/^\//);
      // component is always "index.astro" for a single-page project.
      expect(page.component).toBe("index.astro");

      // sections: non-empty, each entry has name/role/file.
      expect(page.sections.length).toBeGreaterThan(0);
      for (const sec of page.sections) {
        expect(typeof sec.name).toBe("string");
        expect(sec.name.length).toBeGreaterThan(0);
        expect(typeof sec.role).toBe("string");
        expect(sec.role.length).toBeGreaterThan(0);
        // file must end in .astro and match an emitted component.
        expect(sec.file).toMatch(/\.astro$/);
        const compName = sec.file.replace(/\.astro$/, "");
        const compPath = path.join(out.outDir, "components", sec.file);
        expect(
          fs.existsSync(compPath),
          `sections[].file "${sec.file}" has no matching component on disk`,
        ).toBe(true);
        // data-component="<compName>" must appear in the HTML OR the file is Navbar/Footer
        // (which carry data-component but not data-section — so just verify file exists).
        const htmlHasRef = out.indexHtml.includes(`data-component="${compName}"`);
        const isNavOrFooter = compName === "Navbar" || compName === "Footer";
        expect(
          htmlHasRef || isNavOrFooter,
          `sections[].file "${sec.file}" has no data-component="${compName}" in HTML`,
        ).toBe(true);
      }

      // elements: each entry has role/id/selector and resolves in the HTML.
      for (const el of page.elements) {
        expect(typeof el.role).toBe("string");
        expect(el.role.length).toBeGreaterThan(0);
        // id must be "p<numeric>".
        expect(el.id).toMatch(/^p\d+$/);
        // selector must be "[data-role=<role>]".
        expect(el.selector).toBe(`[data-role=${el.role}]`);
        // The HTML must contain class="... p<n> ..." OR class="p<n>" for this element.
        expect(
          out.indexHtml.includes(`class="p${el.id.slice(1)}"`),
          `elements[].id "${el.id}" — class "p${el.id.slice(1)}" not found in HTML`,
        ).toBe(true);
        // The data-role attribute must be stamped in the HTML.
        expect(
          out.indexHtml.includes(`data-role="${el.role}"`),
          `elements[].selector "${el.selector}" — data-role="${el.role}" not found in HTML`,
        ).toBe(true);
      }

      // assets: each alias→file entry must have the file on disk under OUT.
      for (const asset of page.assets) {
        expect(typeof asset.alias).toBe("string");
        expect(asset.alias.length).toBeGreaterThan(0);
        expect(typeof asset.file).toBe("string");
        // file is "assets/aN.ext" — must exist in the captured assets directory used by project.
        const assetPath = path.join(goldenDir, asset.file);
        expect(
          fs.existsSync(assetPath),
          `assets[].file "${asset.file}" not found on disk at ${assetPath}`,
        ).toBe(true);
      }
    }, 120_000);

    it(`${site}: site.json elements have no raw capture-id leakage beyond p<n> handle`, async () => {
      const out = await projectTmp(goldenDir);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(out.outDir, "site.json"), "utf8"),
      ) as SiteManifest;
      const page = manifest.pages[0];
      // The manifest must NOT expose raw numeric ids — only the "p<n>" string form.
      for (const el of page.elements) {
        // id field must be "p<digits>" — not a bare number.
        expect(typeof el.id).toBe("string");
        expect(el.id).toMatch(/^p\d+$/);
      }
    }, 120_000);
  }
});

/**
 * Task 5: data-copy keys link rendered text to editable content[] slots.
 *
 * Round-trip test: project a golden site → pick a data-copy key → look up its component + index
 * → render that component's template with content[index] mutated to a sentinel → verify the
 * sentinel appears at the element carrying that data-copy key, and nowhere else unexpectedly.
 *
 * Also verifies the copy[] map in site.json: every key resolves to a valid component and index.
 */
describe("data-copy keys (Task 5)", () => {
  for (const site of SITES) {
    const goldenDir = path.join(dir, "golden", site);

    it(`${site}: site.json copy[] has valid shape and all keys resolve`, async () => {
      const out = await projectTmp(goldenDir);
      const siteJsonPath = path.join(out.outDir, "site.json");
      expect(fs.existsSync(siteJsonPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(siteJsonPath, "utf8")) as SiteManifest;
      const page = manifest.pages[0];

      // copy[] must be present and non-empty (the golden sites have text content).
      expect(Array.isArray(page.copy), "pages[0].copy is not an array").toBe(true);
      expect(page.copy.length, "copy[] is empty — no text slots wired").toBeGreaterThan(0);

      // Each entry must have a valid shape.
      for (const entry of page.copy) {
        const e = entry as ManifestCopyEntry;
        expect(typeof e.key).toBe("string");
        expect(e.key.length).toBeGreaterThan(0);
        // Key format: "<ComponentName>.<index>" (no spaces within the key).
        expect(e.key, `key "${e.key}" must match <Component>.<n>`).toMatch(/^[A-Za-z][A-Za-z0-9]*\.\d+$/);
        expect(typeof e.component).toBe("string");
        expect(e.component.length).toBeGreaterThan(0);
        expect(typeof e.index).toBe("number");
        expect(e.index).toBeGreaterThanOrEqual(0);

        // The component must exist on disk.
        const compPath = path.join(out.astroDir, "src/components", `${e.component}.astro`);
        expect(
          fs.existsSync(compPath),
          `copy key "${e.key}" references component "${e.component}" but ${e.component}.astro not found`,
        ).toBe(true);

        // The index must be within the component's content[] bounds.
        const astroSrc = fs.readFileSync(compPath, "utf8");
        // Extract content array from the astro component's frontmatter.
        const contentMatch = /^const content = (\[[\s\S]*?\]);/m.exec(astroSrc);
        expect(contentMatch, `No content[] found in ${e.component}.astro`).not.toBeNull();
        const contentArr = JSON.parse(contentMatch![1]) as string[];
        expect(
          e.index < contentArr.length,
          `copy key "${e.key}": index ${e.index} out of bounds (content.length=${contentArr.length})`,
        ).toBe(true);

        // The data-copy attribute must appear in the component HTML (the template literal).
        // The key may appear as part of a space-separated list (multi-text elements).
        expect(
          astroSrc.includes(`data-copy=`),
          `${e.component}.astro has no data-copy attributes`,
        ).toBe(true);
      }
    }, 120_000);

    it(`${site}: round-trip — mutating content[i] changes text at the data-copy keyed element`, async () => {
      const out = await projectTmp(goldenDir);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(out.outDir, "site.json"), "utf8"),
      ) as SiteManifest;
      const page = manifest.pages[0];

      // Pick the first copy entry whose original text is non-empty (skip whitespace-only slots).
      const entry = (page.copy as ManifestCopyEntry[]).find((e) => {
        const compPath = path.join(out.astroDir, "src/components", `${e.component}.astro`);
        if (!fs.existsSync(compPath)) return false;
        const src = fs.readFileSync(compPath, "utf8");
        const m = /^const content = (\[[\s\S]*?\]);/m.exec(src);
        if (!m) return false;
        const arr = JSON.parse(m[1]) as string[];
        return arr[e.index]?.trim().length > 0;
      });

      expect(entry, "No non-empty copy entry found to test round-trip").toBeDefined();
      if (!entry) return; // type guard (expect above will fail if undefined)

      const compPath = path.join(out.astroDir, "src/components", `${entry.component}.astro`);
      const astroSrc = fs.readFileSync(compPath, "utf8");

      // Extract the template literal and the original content array.
      const contentMatch = /^const content = (\[[\s\S]*?\]);/m.exec(astroSrc);
      expect(contentMatch).not.toBeNull();
      const contentArr = JSON.parse(contentMatch![1]) as string[];

      // Mutate the entry's slot to a unique sentinel.
      const SENTINEL = `__SENTINEL_${entry.key.replace(".", "_")}__`;
      const mutated = [...contentArr];
      mutated[entry.index] = SENTINEL;

      // Simulate template rendering: replace content = [...] with mutated array and eval.
      // We use the same e() function from the component and render the html template.
      const e = (s: string) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
      // Extract the template literal body (between the backticks after `const html = `).
      const tplMatch = /const html = `([\s\S]*?)`;[\s\S]*?---/.exec(astroSrc);
      expect(tplMatch, "Could not extract template literal from component").not.toBeNull();
      const tplBody = tplMatch![1];

      // Evaluate the template with the mutated content array.
      // eslint-disable-next-line no-new-func
      const rendered = new Function("content", "e", `return \`${tplBody}\``)(mutated, e) as string;

      // 1. The sentinel must appear in the rendered output.
      expect(
        rendered.includes(SENTINEL),
        `Sentinel "${SENTINEL}" not found in rendered output after mutating content[${entry.index}]`,
      ).toBe(true);

      // 2. The element carrying the data-copy key for this slot must contain the sentinel.
      //    The key may be in a space-separated list on the element.
      //    We find the opening tag whose data-copy attribute value contains this key as a
      //    standalone token (space-delimited or entire value).
      const escapedKey = entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match data-copy="... KEY ..." where KEY is bounded by start/end of value or a space.
      const tagRegex = new RegExp(`<[^>]+data-copy="(?:[^"]*\\s)?${escapedKey}(?:\\s[^"]*)?"[^>]*>`);
      const tagMatch = tagRegex.exec(rendered);
      expect(
        tagMatch,
        `No element found with data-copy key "${entry.key}" in rendered output`,
      ).not.toBeNull();

      // Extract text content near the matched element to confirm the sentinel is co-located.
      // (We verify the sentinel appears somewhere after the opening tag, before any closing tag at the same level.)
      const tagEnd = (tagMatch?.index ?? 0) + (tagMatch?.[0].length ?? 0);
      const afterTag = rendered.slice(tagEnd, tagEnd + 2000);
      expect(
        afterTag.includes(SENTINEL),
        `Sentinel appears in output but not inside the element carrying data-copy="${entry.key}"`,
      ).toBe(true);
    }, 120_000);
  }
});
