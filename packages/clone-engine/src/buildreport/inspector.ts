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

export async function inspectSite(opts: InspectOpts): Promise<SiteReport> {
  const { siteDir, browser, width = 1440, source } = opts;
  const manifest = JSON.parse(fs.readFileSync(path.join(siteDir, "site.json"), "utf8")) as SiteManifest;

  const allIssues: Issue[] = [];
  const pageReports: PageReport[] = [];

  for (const page of manifest.pages) {
    const distDir = path.join(siteDir, "astro", "dist");
    const distHtmlPath = path.join(distDir, "index.html");

    // Run layout-breaks first — it calls renderSnapshot which builds the Astro dist.
    // Static checks must read the built dist, so we build it here before reading.
    const stubCtx: PageContext = { route: page.route, distHtmlPath, distHtml: "", distDir, siteDir, source };
    const layoutResult = await checkLayoutBreaks(stubCtx, browser, width);

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

    let fidelityPct: number | undefined;
    if (source) {
      const fid = await checkFidelity(ctx, browser, width);
      pageIssues.push(...fid.issues);
      fidelityPct = fid.fidelityPct;
    }

    const weightIssue = pageIssues.find((i) => i.kind === "pagespeed-weight");
    const pageWeightKb = weightIssue ? parseFloat(weightIssue.detail.replace(/[^0-9.]/g, "")) : 0;

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
