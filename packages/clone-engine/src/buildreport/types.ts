import type { Browser } from "playwright";

export type IssueSeverity = "blocker" | "note" | "info";

export interface Issue {
  severity: IssueSeverity;
  page: string;         // route e.g. "/" or "/about/"
  section?: string;     // data-component name if section-scoped
  kind: string;         // machine-readable check id e.g. "broken-asset"
  detail: string;       // human-readable one-liner
}

export interface CheckResult { issues: Issue[]; }

/** Context passed to every check for a single page. */
export interface PageContext {
  route: string;
  /** Absolute path to the built dist/index.html (or dist/<route>/index.html). */
  distHtmlPath: string;
  /** Parsed text of the built HTML file. */
  distHtml: string;
  /** Absolute path to the built dist/ directory for this page. */
  distDir: string;
  /** Absolute path to the site dir (has site.json, astro/). */
  siteDir: string;
  /** Optional source capture dir — enables clone-fidelity checks. */
  source?: { captureDir: string };
}

export interface InspectOpts {
  /** Projected site dir (has site.json + astro/dist/). */
  siteDir: string;
  /** Playwright browser for render-based checks (layout-breaks, fidelity). */
  browser: Browser;
  /** Default render width. @default 1440 */
  width?: number;
  /** Supply for clone-fidelity checks (SEO regression, iframe preservation, pixel diff). */
  source?: { captureDir: string };
}

export interface PageReport {
  route: string;
  issues: Issue[];
  fidelityPct?: number;   // 0-100, only when source provided
  pageWeightKb: number;
}

export interface SiteReport {
  /** "SHIP" = zero blockers. "NEEDS_FIXES" = ≥1 blocker. */
  verdict: "SHIP" | "NEEDS_FIXES";
  blockerCount: number;
  noteCount: number;
  infoCount: number;
  issues: Issue[];
  pages: PageReport[];
  generatedAt: string;  // ISO timestamp
}
