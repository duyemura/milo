import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { SiteManifest } from "../../types.ts";
import { getLinks } from "../html.ts";

function isInternal(href: string): boolean {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  return !href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("//");
}

function normalizeRoute(href: string): string {
  const p = href.split("?")[0].split("#")[0];
  return p.endsWith("/") ? p : p + "/";
}

export async function checkDeadLinks(page: PageContext): Promise<CheckResult> {
  const manifest = JSON.parse(fs.readFileSync(path.join(page.siteDir, "site.json"), "utf8")) as SiteManifest;
  const builtRoutes = new Set(manifest.pages.map((p) => p.route));
  builtRoutes.add("/");

  const issues = [];
  for (const href of getLinks(page.distHtml)) {
    if (!isInternal(href)) continue;
    const route = normalizeRoute(href);
    if (!builtRoutes.has(route)) {
      issues.push({ severity: "blocker" as const, page: page.route, kind: "dead-link", detail: `Internal link "${href}" has no matching built page` });
    }
  }
  return { issues };
}
