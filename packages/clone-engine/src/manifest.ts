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

export interface BuildManifestArgs {
  /** BASE path for the site (empty string = root "/"). */
  base: string;
  /** Ordered region list produced by project.ts after dedup; each entry has a deduped file name. */
  regions: Array<{ name: string; file: string; sectionRole: string }>;
  /** labels.elements — semantic element labels. */
  elements: Labels["elements"];
  /** labels.assets — asset alias→file map (file = "assets/aN.ext" on disk). */
  assets: Labels["assets"];
  /**
   * Copy map entries collected by buildTpl across all regions.
   * Each entry: { key: "<ComponentName>.<index>", component, index }.
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

  // Sections: every region (Navbar, content sections, Footer) gets an entry.
  // The `role` comes from the label system for content sections; for Navbar/Footer
  // we synthesise it directly from the region name (nav → "nav", footer → "footer").
  const sections: ManifestSection[] = regions.map((r) => ({
    name: r.name,
    role: r.sectionRole,
    file: `${r.file}.astro`,
  }));

  // Elements: each labeled element becomes an addressable handle.
  // id = "p<n>" (the CSS class stamped on the element in the HTML).
  // selector = "[data-role=<role>]" (the data-* attribute stamped by project.ts).
  const manifestElements: ManifestElement[] = elements.map((e) => ({
    role: e.role,
    id: `p${e.id}`,
    selector: `[data-role=${e.role}]`,
  }));

  // Assets: map alias → rehosted file path ("assets/aN.ext").
  // The `file` field in labels.assets is already the rehosted path (e.g. "assets/a1.png")
  // as written by the capture/rehost step; we expose it verbatim.
  const manifestAssets: ManifestAsset[] = assets.map((a) => ({
    alias: a.alias,
    file: a.file,
  }));

  return {
    brand: "brand.json",
    pages: [
      {
        route,
        component: "index.astro",
        sections,
        elements: manifestElements,
        assets: manifestAssets,
        copy,
      },
    ],
  };
}
