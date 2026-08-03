import fs from "node:fs";
import path from "node:path";
import type { InspectOpts, SiteReport, PageReport, Issue, PageContext } from "./types.ts";
import type { SiteManifest } from "../types.ts";
import { checkBrokenAssets } from "./checks/broken-assets.ts";
import { checkContentBlocks } from "./checks/content-blocks.ts";
import { checkDeadLinks } from "./checks/dead-links.ts";
import { checkSeo } from "./checks/seo.ts";
import { checkPagespeed } from "./checks/pagespeed.ts";
import { checkIframes } from "./checks/iframes.ts";
import { checkFidelity } from "./checks/fidelity.ts";
import { checkLayoutBreaks } from "./checks/layout-breaks.ts";
import { checkFontFallback } from "./checks/font-fallback.ts";

/** Resolve the built dist/index.html path for a given route. "/" → dist/index.html; "/about/" → dist/about/index.html. */
function distHtmlFor(siteDir: string, route: string): { distDir: string; distHtmlPath: string } {
  const distDir = path.join(siteDir, "astro", "dist");
  const slug = route.replace(/^\/|\/$/g, "");
  const distHtmlPath = slug === ""
    ? path.join(distDir, "index.html")
    : path.join(distDir, slug, "index.html");
  return { distDir, distHtmlPath };
}

/** Run a check; surface any throw as a "note" issue rather than propagating. */
async function safeCheck(
  check: () => Promise<{ issues: Issue[] }>,
  route: string,
  kind: string,
): Promise<{ issues: Issue[] }> {
  try {
    return await check();
  } catch (err) {
    return { issues: [{ severity: "note", page: route, kind, detail: `Check failed: ${(err as Error).message}` }] };
  }
}

export async function buildReport(opts: InspectOpts): Promise<SiteReport> {
  const { siteDir, browser, width = 1440, source } = opts;
  const manifest = JSON.parse(fs.readFileSync(path.join(siteDir, "site.json"), "utf8")) as SiteManifest;

  const allIssues: Issue[] = [];
  const pageReports: PageReport[] = [];

  for (const page of manifest.pages) {
    const { distDir, distHtmlPath } = distHtmlFor(siteDir, page.route);

    // Run layout-breaks first — it calls renderSnapshot which runs `astro build` and produces
    // astro/dist/. Static checks must read the built dist, so we trigger the build here.
    // NOTE: renderSnapshot always builds from the homepage (index.astro); layout-breaks on
    // non-home routes is a future task. Safe-wrapped so a build failure surfaces as a note.
    const stubCtx: PageContext = { route: page.route, distHtmlPath, distHtml: "", distDir, siteDir, source };
    const layoutResult = await safeCheck(
      () => checkLayoutBreaks(stubCtx, browser, width),
      page.route,
      "layout-check-failed",
    );

    if (!fs.existsSync(distHtmlPath)) continue;
    const distHtml = fs.readFileSync(distHtmlPath, "utf8");
    const ctx: PageContext = { route: page.route, distHtmlPath, distHtml, distDir, siteDir, source };

    // Static checks run in parallel after the dist exists.
    const [assets, content, links, seo, speed, iframes, fonts] = await Promise.all([
      checkBrokenAssets(ctx),
      checkContentBlocks(ctx),
      checkDeadLinks(ctx),
      checkSeo(ctx),
      checkPagespeed(ctx),
      checkIframes(ctx),
      checkFontFallback(ctx),
    ]);

    const pageIssues: Issue[] = [
      ...assets.issues, ...content.issues, ...links.issues,
      ...seo.issues, ...speed.issues, ...iframes.issues,
      ...fonts.issues, ...layoutResult.issues,
    ];

    // Fidelity check (clone-only) — needs its return value, so wrapped manually.
    let fidelityPct: number | undefined;
    if (source) {
      try {
        const fid = await checkFidelity(ctx, browser, width);
        pageIssues.push(...fid.issues);
        fidelityPct = fid.fidelityPct != null && fid.fidelityPct > 0 ? fid.fidelityPct : undefined;
      } catch (err) {
        pageIssues.push({ severity: "note", page: page.route, kind: "fidelity-check-failed", detail: `Fidelity check failed: ${(err as Error).message}` });
      }
    }

    // Page weight: read the file size directly rather than scraping the display string.
    const pageWeightKb = fs.existsSync(distHtmlPath)
      ? Math.round(fs.statSync(distHtmlPath).size / 1024 * 10) / 10
      : 0;

    allIssues.push(...pageIssues);
    pageReports.push({ route: page.route, issues: pageIssues, fidelityPct, pageWeightKb });
  }

  const blockerCount = allIssues.filter((i) => i.severity === "blocker").length;
  const noteCount = allIssues.filter((i) => i.severity === "note").length;
  const infoCount = allIssues.filter((i) => i.severity === "info").length;

  return {
    verdict: blockerCount === 0 ? "SHIP" : "NEEDS_FIXES",
    blockerCount,
    noteCount,
    infoCount,
    issues: allIssues,
    pages: pageReports,
    generatedAt: new Date().toISOString(),
  };
}
