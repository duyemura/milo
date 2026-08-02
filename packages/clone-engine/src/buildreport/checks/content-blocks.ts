import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { SiteManifest } from "../../types.ts";

export async function checkContentBlocks(page: PageContext): Promise<CheckResult> {
  const manifest = JSON.parse(fs.readFileSync(path.join(page.siteDir, "site.json"), "utf8")) as SiteManifest;
  const sections = manifest.pages[0]?.sections ?? [];
  const issues = [];

  for (const section of sections) {
    const marker = `data-component="${section.name}"`;
    if (!page.distHtml.includes(marker)) {
      issues.push({ severity: "blocker" as const, page: page.route, section: section.name, kind: "missing-section", detail: `Section "${section.name}" (role: ${section.role}) from site.json is absent in the built HTML` });
      continue;
    }
    // Extract text content from the section (strip HTML tags between data-component start and </section>)
    const start = page.distHtml.indexOf(marker);
    const tagStart = page.distHtml.lastIndexOf("<", start);
    const end = page.distHtml.indexOf("</section>", tagStart);
    if (end === -1) continue;
    const inner = page.distHtml.slice(tagStart, end + 10).replace(/<[^>]+>/g, " ");
    if (inner.trim().length === 0) {
      issues.push({ severity: "blocker" as const, page: page.route, section: section.name, kind: "empty-section", detail: `Section "${section.name}" exists but has no visible text content` });
    }
  }
  return { issues };
}
