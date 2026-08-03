import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { BrandDoc } from "../../types.ts";

export async function checkFontFallback(page: PageContext): Promise<CheckResult> {
  const brandPath = path.join(page.siteDir, "astro", "brand.json");
  if (!fs.existsSync(brandPath)) return { issues: [] };
  const brand = JSON.parse(fs.readFileSync(brandPath, "utf8")) as BrandDoc;
  const cssPath = path.join(page.siteDir, "astro", "src", "styles", "global.css");
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";

  const fontSlots: Array<{ slot: string; family: string }> = [
    { slot: "display", family: brand.fonts.display },
    { slot: "body", family: brand.fonts.body },
  ].filter((f) => f.family);

  const issues = [];
  for (const font of fontSlots) {
    if (!css.toLowerCase().includes(font.family.toLowerCase())) {
      issues.push({
        severity: "note" as const,
        page: page.route,
        kind: "font-fallback",
        detail: `Brand font "${font.family}" (slot: ${font.slot}) not found in global.css — may fall back to system font`,
      });
    }
  }
  return { issues };
}
