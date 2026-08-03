/**
 * digest.ts — compact, token-budgeted site view for the planner prompt.
 *
 * Pure function: reads site.json + astro/brand.json, returns SiteDigest.
 * No LLM, no side effects beyond file reads.
 */
import fs from "node:fs";
import path from "node:path";
import { loadSite } from "./target.ts";
import type { SiteRef, SiteDigest, DigestPage, DigestSection, DigestBrand, DigestLibraryAsset } from "./types.ts";
import type { BrandDoc } from "../types.ts";
import { loadLibrary } from "../assets/library.ts";

const PREVIEW_LEN = 60;

function truncate(text: string): string {
  return text.length <= PREVIEW_LEN ? text : text.slice(0, PREVIEW_LEN - 1) + "…";
}

/**
 * Build a compact JSON site view for inclusion in the planner prompt.
 *
 * Includes per page: sections (name, role, copyKeys with short previews, elementRoles,
 * assetAliases), and brand slot colors. Keeps payload small — this goes in the prompt.
 */
export function digest(site: SiteRef): SiteDigest {
  const manifest = loadSite(site);

  // Collect all asset aliases (deduplicated across pages).
  const allAliases = new Set<string>();
  for (const page of manifest.pages) {
    for (const asset of page.assets) {
      allAliases.add(asset.alias);
    }
  }

  const pages: DigestPage[] = manifest.pages.map((page) => {
    const sections: DigestSection[] = page.sections.map((section) => {
      // Copy entries owned by this section, with truncated previews.
      const copyKeys = page.copy
        .filter((c) => c.component === section.name)
        .map((c) => ({ key: c.key, preview: truncate(c.text) }));

      // Element roles inside this section.
      const elementRoles = page.elements
        .filter((e) => e.component === section.name)
        .map((e) => e.role);

      // Asset aliases — all page-level aliases (manifest doesn't track per-section asset ownership).
      const assetAliases = page.assets.map((a) => a.alias);

      return {
        name: section.name,
        role: section.role,
        copyKeys,
        elementRoles,
        assetAliases,
      };
    });

    return { route: page.route, type: page.type, goal: page.goal, sections };
  });

  // Read brand.json for color slots. Fall back gracefully if absent.
  const brand = loadBrand(site);

  // Load the asset library (if it exists) and include active, tagged assets in the digest
  // so the planner can reference specific assetIds in placeAsset ops.
  const lib = loadLibrary(site.dir, "biz_unknown");
  const libraryAssets: DigestLibraryAsset[] = Object.values(lib.assets)
    .filter((a) => a.status === "active" && !a.tags.pending)
    .map((a) => ({
      id: a.id,
      description: a.tags.description,
      subjects: a.tags.subjects,
      mood: a.tags.mood,
      quality: a.tags.quality,
      hasPeople: a.tags.hasPeople,
      ...(a.siteOrigin !== undefined ? { siteOrigin: a.siteOrigin } : {}),
    }));

  return {
    pages,
    brand,
    assetAliases: [...allAliases],
    libraryAssets,
  };
}

function loadBrand(site: SiteRef): DigestBrand {
  const brandPath = path.join(site.dir, "astro", "brand.json");
  const fallback: DigestBrand = {
    primary: "unknown",
    accent: "unknown",
    surface: "unknown",
    text: "unknown",
    muted: "unknown",
  };

  if (!fs.existsSync(brandPath)) return fallback;

  try {
    const doc = JSON.parse(fs.readFileSync(brandPath, "utf8")) as BrandDoc;
    const colors = doc.colors as Record<string, { hex?: string; value?: string }>;
    return {
      primary: colors.primary?.hex ?? colors.primary?.value ?? "unknown",
      accent: colors.accent?.hex ?? colors.accent?.value ?? "unknown",
      surface: colors.surface?.hex ?? colors.surface?.value ?? "unknown",
      text: colors.text?.hex ?? colors.text?.value ?? "unknown",
      muted: colors.muted?.hex ?? colors.muted?.value ?? "unknown",
    };
  } catch {
    return fallback;
  }
}
