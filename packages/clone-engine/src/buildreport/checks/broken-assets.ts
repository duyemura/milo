import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import { getImgSrcs, getCssBackgroundUrls } from "../html.ts";

function resolveAsset(src: string, distDir: string): string | null {
  if (/^https?:\/\//.test(src) || src.startsWith("data:") || src.startsWith("//")) return null;
  const rel = src.startsWith("/") ? src.slice(1) : src;
  return path.join(distDir, rel);
}

export async function checkBrokenAssets(page: PageContext): Promise<CheckResult> {
  const issues = [];
  const candidates = [
    ...getImgSrcs(page.distHtml),
    ...getCssBackgroundUrls(page.distHtml),
  ];
  for (const src of candidates) {
    const abs = resolveAsset(src, page.distDir);
    if (!abs) continue;
    if (!fs.existsSync(abs)) {
      issues.push({ severity: "blocker" as const, page: page.route, kind: "broken-asset", detail: `Asset not found: ${src}` });
    }
  }
  return { issues };
}
