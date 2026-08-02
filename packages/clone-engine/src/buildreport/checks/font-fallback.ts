import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";

interface BrandJson { fonts: { slot: string; family: string }[] }

export async function checkFontFallback(page: PageContext): Promise<CheckResult> {
  const brandPath = path.join(page.siteDir, "astro", "brand.json");
  if (!fs.existsSync(brandPath)) return { issues: [] };
  const brand = JSON.parse(fs.readFileSync(brandPath, "utf8")) as BrandJson;
  const cssPath = path.join(page.siteDir, "astro", "src", "styles", "global.css");
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";

  const issues = [];
  for (const font of brand.fonts) {
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
