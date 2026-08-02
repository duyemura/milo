/**
 * manifest.ts — `site.json` manifest emitter (Plan 2, Task 4).
 *
 * Produces the machine-readable site map that an LLM agent uses to address every
 * named part of the projected site: sections → components, elements → data-role
 * selectors, assets → rehosted file paths, brand → brand.json.
 *
 * Pure data transform — NO browser, NO file I/O beyond what callers request.
 * Pixel oracle: calling buildManifest never touches HTML/CSS output, so 0-px is
 * trivially preserved.
 */
import type { Labels, SiteManifest, ManifestSection, ManifestElement, ManifestAsset, ManifestCopyEntry } from "./types.ts";

/** The editable brand doc + component + page files ship inside the astro/ project. */
const BRAND_PATH = "astro/brand.json";
const COMPONENT_DIR = "astro/src/components";
const PAGE_PATH = "astro/src/pages/index.astro";

export interface BuildManifestArgs {
  /** BASE path for the site (empty string = root "/"). */
  base: string;
  /** Ordered region list produced by project.ts after dedup; each entry has a deduped file name. */
  regions: Array<{ name: string; file: string; sectionRole: string }>;
  /**
   * labels.elements — semantic element labels, each augmented with `component` (the owning
   * section component name) so elements can be section-scoped and joined into sections[].
   */
  elements: Array<{ id: number; role: string; component?: string }>;
  /** labels.assets — asset alias→file map (file = "assets/aN.ext" on disk). */
  assets: Labels["assets"];
  /**
   * Copy map entries collected by buildTpl across all regions.
   * Each entry: { key: "<ComponentName>.<index>", component, index, text, role? }.
   */
  copy: ManifestCopyEntry[];
}

/**
 * Build a SiteManifest for the single page currently being projected.
 *
 * One `ManifestPage` is produced per call — this matches the one-page-per-project()
 * architecture. Multi-page support adds another entry at the caller level.
 */
export function buildManifest(args: BuildManifestArgs): SiteManifest {
  const { base, regions, elements, assets, copy } = args;

  // Route: BASE with trailing slash stripped; "/" when empty.
  const route = base ? `${base}/` : "/";

  // Elements: each labeled element becomes an addressable handle.
  // id = "p<n>" (the CSS class stamped on the element in the HTML).
  // selector is SECTION-SCOPED — "[data-component=<Comp>] [data-role=<role>]" — so a role that
  // recurs across sections isn't ambiguous. Falls back to the bare "[data-role]" when the
  // element's owning component is unknown (shouldn't happen for in-region elements).
  const manifestElements: ManifestElement[] = elements.map((e) => ({
    role: e.role,
    id: `p${e.id}`,
    component: e.component ?? "",
    selector: e.component
      ? `[data-component="${e.component}"] [data-role="${e.role}"]`
      : `[data-role="${e.role}"]`,
  }));

  // Sections: every region (Navbar, content sections, Footer) gets an entry with the EXPLICIT
  // editable file path + its owned copy keys and element roles pre-joined (so C never re-derives
  // the join or guesses the path).
  const copyKeysByComponent = new Map<string, string[]>();
  for (const c of copy) {
    const arr = copyKeysByComponent.get(c.component) ?? [];
    arr.push(c.key);
    copyKeysByComponent.set(c.component, arr);
  }
  const sections: ManifestSection[] = regions.map((r) => ({
    name: r.name,
    role: r.sectionRole,
    file: `${COMPONENT_DIR}/${r.file}.astro`,
    copyKeys: copyKeysByComponent.get(r.file) ?? [],
    elementRoles: manifestElements
      .filter((e) => e.component === r.file)
      .map((e) => ({ role: e.role, id: e.id })),
  }));

  // Assets: map alias → rehosted file path ("assets/aN.ext").
  // The `file` field in labels.assets is already the rehosted path (e.g. "assets/a1.png")
  // as written by the capture/rehost step; we expose it verbatim.
  const manifestAssets: ManifestAsset[] = assets.map((a) => ({
    alias: a.alias,
    file: a.file,
  }));

  return {
    brand: BRAND_PATH,
    pages: [
      {
        route,
        component: PAGE_PATH,
        sections,
        elements: manifestElements,
        assets: manifestAssets,
        copy,
      },
    ],
  };
}
