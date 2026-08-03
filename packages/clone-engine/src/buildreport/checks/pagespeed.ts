import fs from "node:fs";
import type { CheckResult, PageContext } from "../types.ts";
import { countTag } from "../html.ts";

export async function checkPagespeed(page: PageContext): Promise<CheckResult> {
  const stats = fs.statSync(page.distHtmlPath);
  const pageWeightKb = Math.round(stats.size / 1024 * 10) / 10;
  const imgCount = countTag(page.distHtml, "img");
  const scriptCount = countTag(page.distHtml, "script");
  const linkCount = [...page.distHtml.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi)].length;
  return {
    issues: [
      { severity: "info", page: page.route, kind: "pagespeed-weight", detail: `Page weight: ${pageWeightKb} KB` },
      { severity: "info", page: page.route, kind: "pagespeed-assets", detail: `${imgCount} images, ${scriptCount} scripts, ${linkCount} stylesheets` },
    ],
  };
}
