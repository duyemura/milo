import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { SiteManifest } from "../../types.ts";

export async function checkContentBlocks(page: PageContext): Promise<CheckResult> {
  const manifest = JSON.parse(fs.readFileSync(path.join(page.siteDir, "site.json"), "utf8")) as SiteManifest;
  // Look up the page by route; fall back to pages[0] for the common single-page case.
  const manifestPage = manifest.pages.find((p) => p.route === page.route) ?? manifest.pages[0];
  const sections = manifestPage?.sections ?? [];
  const issues = [];

  for (const section of sections) {
    const compMarker = `data-component="${section.name}"`;
    if (!page.distHtml.includes(compMarker)) {
      issues.push({
        severity: "blocker" as const,
        page: page.route,
        section: section.name,
        kind: "missing-section",
        detail: `Section "${section.name}" (role: ${section.role}) from site.json is absent in the built HTML`,
      });
      continue;
    }

    // Check content by looking for any copy slot with non-empty text.
    // Uses copyKeys (data-copy attributes) — robust to any wrapping tag and nesting.
    const hasContent = section.copyKeys.some((key) => {
      const marker = `data-copy="${key}"`;
      const idx = page.distHtml.indexOf(marker);
      if (idx === -1) return false;
      const tagEnd = page.distHtml.indexOf(">", idx);
      if (tagEnd === -1) return false;
      const nextTag = page.distHtml.indexOf("<", tagEnd + 1);
      const text = page.distHtml.slice(tagEnd + 1, nextTag === -1 ? undefined : nextTag).trim();
      return text.length > 0;
    });

    if (!hasContent && section.copyKeys.length > 0) {
      issues.push({
        severity: "blocker" as const,
        page: page.route,
        section: section.name,
        kind: "empty-section",
        detail: `Section "${section.name}" exists but all copy slots are empty`,
      });
    }
  }
  return { issues };
}
