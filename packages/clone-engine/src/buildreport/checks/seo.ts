import fs from "node:fs";
import path from "node:path";
import type { CheckResult, Issue, PageContext } from "../types.ts";
import type { CaptureJson } from "../../types.ts";
import { getTextContent, countTag, parseMetas, hasJsonLd, countImgsWithoutAlt } from "../html.ts";

function parseSourceSeo(captureDir: string): { title: string; description: string } {
  const cap = JSON.parse(fs.readFileSync(path.join(captureDir, "capture.json"), "utf8")) as CaptureJson;
  const title = cap.head.title ?? "";
  const description = cap.head.metas.find((m) => m.key === "description")?.content ?? "";
  return { title, description };
}

export async function checkSeo(ctx: PageContext): Promise<CheckResult> {
  const issues: Issue[] = [];
  const html = ctx.distHtml;

  const title = getTextContent(html, "title");
  const metas = parseMetas(html);
  const h1Count = countTag(html, "h1");
  const missingAlt = countImgsWithoutAlt(html);

  if (!title) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-title", detail: "Page has no <title> tag" });
  if (!metas.get("description")) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-description", detail: "Page has no meta description" });
  if (h1Count === 0) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-h1", detail: "Page has no <h1> heading" });
  if (h1Count > 1) issues.push({ severity: "info", page: ctx.route, kind: "seo-multiple-h1", detail: `Page has ${h1Count} <h1> headings (should be exactly 1)` });
  if (missingAlt > 0) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-alt", detail: `${missingAlt} image(s) lack alt attributes` });
  if (!hasJsonLd(html)) issues.push({ severity: "info", page: ctx.route, kind: "seo-no-json-ld", detail: "No JSON-LD structured data found" });

  // Clone regression: source had a field → clone must keep it.
  if (ctx.source?.captureDir) {
    const src = parseSourceSeo(ctx.source.captureDir);
    if (src.title && !title) {
      issues.push({ severity: "blocker", page: ctx.route, kind: "seo-regression", detail: `<title> was "${src.title}" in source but is missing in clone` });
    }
    if (src.description && !metas.get("description")) {
      issues.push({ severity: "blocker", page: ctx.route, kind: "seo-regression", detail: "meta description was present in source but is missing in clone" });
    }
  }

  return { issues };
}
