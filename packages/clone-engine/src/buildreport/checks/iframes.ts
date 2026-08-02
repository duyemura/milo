import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { CaptureJson } from "../../types.ts";
import { getIframeSrcs } from "../html.ts";

export async function checkIframes(page: PageContext): Promise<CheckResult> {
  if (!page.source?.captureDir) return { issues: [] };
  const captureDir = page.source.captureDir;
  const cap = JSON.parse(fs.readFileSync(path.join(captureDir, "capture.json"), "utf8")) as CaptureJson & { sourceOrigins?: string[] };
  const sourceOrigins: string[] = cap.sourceOrigins ?? [];

  // Collect iframe srcs from source capture tree
  const sourceSrcs: string[] = [];
  const walk = (n: { tag?: string; attrs?: Record<string, string>; children?: unknown[] }) => {
    if (n.tag === "iframe" && n.attrs?.src) sourceSrcs.push(n.attrs.src);
    for (const c of n.children ?? []) walk(c as typeof n);
  };
  walk(cap.tree as Parameters<typeof walk>[0]);

  if (sourceSrcs.length === 0) return { issues: [] };

  const cloneSrcs = new Set(getIframeSrcs(page.distHtml));
  const issues = [];

  for (const src of sourceSrcs) {
    if (!cloneSrcs.has(src)) {
      issues.push({ severity: "blocker" as const, page: page.route, kind: "dropped-iframe", detail: `iframe src="${src}" present in source was dropped in clone` });
    } else {
      const isSameDomain = sourceOrigins.some((origin) => src.startsWith(origin));
      if (isSameDomain) {
        issues.push({ severity: "note" as const, page: page.route, kind: "same-domain-iframe", detail: `iframe src="${src}" is on the source's domain — may not load off-origin` });
      }
    }
  }
  return { issues };
}
