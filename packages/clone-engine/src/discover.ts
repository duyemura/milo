/**
 * discover.ts — Sitemap-based page discovery for clone-engine.
 *
 * Handles two real-world sitemap shapes:
 *   - Flat urlset (Squarespace): <urlset><url><loc>…</loc></url></urlset>
 *   - Sitemap index (WordPress): <sitemapindex><sitemap><loc>…</loc></sitemap></sitemapindex>
 *     → fetch each sub-sitemap; tag post-* sub-sitemaps as UGC-origin.
 *
 * Fallback: if no sitemap, scrape same-origin <a href> from homepage nav/header/footer.
 *
 * Classification:
 *   UGC if path matches /(blog|news|post|posts|article|articles|events?|resources)/[^/]+
 *   OR the URL came from a post-* sub-sitemap.
 *   Junk exclusions: /search, /cart, /privacy-policy, /terms*, *.xml, feed URLs, query-only, fragments.
 *
 * De-dupes by normalized path (trailing slash added). Caps UGC at ugcLimit (default 25),
 * logging when truncated. Keeps core sorted with "/" first.
 */

import type { PageSpec } from "./orchestrate.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoverOpts {
  /** Max UGC pages to return (default 25). Logs a warning when truncating. */
  ugcLimit?: number;
  /**
   * Optional incremental callback fired as pages are found, so a UI can show the
   * discovered count growing (page 4/18 → 4/19). Reports the running core/ugc split
   * and the routes so far. Fired at least once (final) before discoverPages returns.
   */
  onProgress?: (p: { coreFound: number; ugcFound: number; routes: string[] }) => void;
}

export interface DiscoverResult {
  core: PageSpec[];
  ugc: PageSpec[];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchText(url: string, retries = 1): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      return await resp.text();
    } catch (err) {
      if (attempt < retries) continue;
      throw err;
    }
  }
  // Unreachable, but TypeScript needs it
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// XML parsing helpers (regex-based, no external deps)
// ---------------------------------------------------------------------------

/** Extract all <loc> text values from an XML string. */
function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1].trim());
  }
  return locs;
}

/** True if the XML root element is <sitemapindex …> (WordPress-style). */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

// ---------------------------------------------------------------------------
// URL normalization + classification
// ---------------------------------------------------------------------------

const JUNK_PATHS = /^\/(search|cart|checkout|feed|wp-json|wp-login\.php|wp-admin|admin)(\/|$)/i;
const JUNK_SEGMENTS = /\/(privacy-policy|terms|terms-of-service|terms-of-use|cookie-policy|legal|gdpr)(\/?)$/i;
const UGC_PATTERN = /^\/(blog|news|post|posts|article|articles|events?|resources)\/[^/]+/i;

/**
 * Normalize a URL to a path string (trailing slash added, query/fragment stripped).
 * Returns null if the URL is not same-origin, not http(s), or is obviously junk.
 */
function normalizePath(raw: string, originHostname: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.protocol.startsWith("http")) return null;
  if (url.hostname !== originHostname) return null;

  // Skip .xml / feed / API paths
  const ext = url.pathname.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xml" || ext === "rss" || ext === "atom") return null;
  if (url.pathname.includes("/feed/")) return null;

  let p = url.pathname;
  // Must start with /
  if (!p.startsWith("/")) return null;
  // Junk path checks
  if (JUNK_PATHS.test(p)) return null;
  if (JUNK_SEGMENTS.test(p)) return null;

  // Normalize trailing slash (only for path-only URLs, not file extensions)
  if (!p.endsWith("/") && !p.match(/\.[a-z]{2,5}$/i)) {
    p = p + "/";
  }

  return p;
}

function isUgcPath(path: string): boolean {
  return UGC_PATTERN.test(path);
}

/**
 * Derive a short deterministic slug from a hostname for out-dir namespacing.
 * e.g. "speakeasyofstrength.com" → "speakeasyofstrength"
 *      "www.ksathleticclub.com" → "ksathleticclub"
 *      "torrancetraininglab.com" → "torrancetraining" (capped at 20 chars)
 */
export function originSlug(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = origin;
  }
  // Strip www. prefix
  host = host.replace(/^www\./, "");
  // Drop TLD (.com, .net, etc.) — keep the main name only
  const parts = host.split(".");
  const name = parts.length >= 2 ? parts.slice(0, -1).join("") : parts[0];
  // Sanitize to alphanumeric + hyphens, max 20 chars
  return name.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 20);
}

/**
 * Build a per-page `dir` slug for a given path, namespaced by the origin slug's first 2 chars.
 * e.g. originSlug="speakeasyofstrength", route="/" → "sp-home"
 *      originSlug="torrancetraining",    route="/" → "to-home"
 *
 * The 2-char prefix ensures different origins never collide on the same route.
 */
export function pageDir(originSlugStr: string, route: string): string {
  const prefix = originSlugStr.slice(0, 2);
  const slug = route === "/"
    ? "home"
    : route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${prefix}-${slug}`;
}

// ---------------------------------------------------------------------------
// Fallback: scrape nav/header/footer links from homepage
// ---------------------------------------------------------------------------

async function fallbackFromHomepage(origin: string, originHostname: string): Promise<string[]> {
  let html: string;
  try {
    html = await fetchText(origin.replace(/\/$/, "") + "/");
  } catch {
    return [];
  }

  const paths = new Set<string>();
  const re = /<a\s[^>]*href=["']([^"'#?][^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    let fullUrl: string;
    try {
      fullUrl = new URL(raw, origin).href;
    } catch {
      continue;
    }
    const p = normalizePath(fullUrl, originHostname);
    if (p) paths.add(p);
  }
  return [...paths];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Discover all pages of a site via its sitemap (or homepage link fallback).
 *
 * Returns core pages (with "/" first) and UGC pages (capped at ugcLimit).
 * Each PageSpec.dir is namespaced by origin slug to avoid multi-site cwd collisions.
 */
export async function discoverPages(
  origin: string,
  opts: DiscoverOpts = {},
): Promise<DiscoverResult> {
  const ugcLimit = opts.ugcLimit ?? 25;
  const cleanOrigin = origin.replace(/\/$/, "");
  const originHostname = new URL(cleanOrigin + "/").hostname;
  const slug = originSlug(origin);

  // Sentinel prefix for UGC-tagged paths from post-* sub-sitemaps
  const UGC_TAG = "__ugc__";

  let allPaths: string[] = [];
  let sitemapOk = false;

  const emitProgress = () => {
    if (!opts.onProgress) return;
    const core = new Set<string>(["/"]);
    const ugc = new Set<string>();
    for (const raw of allPaths) {
      const tagged = raw.startsWith(UGC_TAG);
      const p = tagged ? raw.slice(UGC_TAG.length) : raw;
      if (p === "/") continue;
      if (tagged || isUgcPath(p)) ugc.add(p); else core.add(p);
    }
    opts.onProgress({ coreFound: core.size, ugcFound: ugc.size, routes: [...core, ...ugc] });
  };

  // --- Try sitemap ---
  try {
    const sitemapXml = await fetchText(`${cleanOrigin}/sitemap.xml`);

    if (isSitemapIndex(sitemapXml)) {
      // WordPress-style: fetch each sub-sitemap and union URLs
      const subUrls = extractLocs(sitemapXml).filter((u) => u.endsWith(".xml"));
      for (const subUrl of subUrls) {
        // Sub-sitemaps whose URL contains "post" are UGC-origin
        const isUgcSub = /post/i.test(subUrl);
        try {
          const subXml = await fetchText(subUrl);
          const locs = extractLocs(subXml);
          for (const loc of locs) {
            const p = normalizePath(loc, originHostname);
            if (!p) continue;
            // Tag UGC-origin paths with sentinel so we can identify them post-normalization
            allPaths.push(isUgcSub ? `${UGC_TAG}${p}` : p);
          }
          emitProgress();
        } catch (err) {
          console.warn(`[discover] failed to fetch sub-sitemap ${subUrl}: ${(err as Error).message}`);
        }
      }
    } else {
      // Flat urlset (Squarespace-style)
      const locs = extractLocs(sitemapXml);
      for (const loc of locs) {
        const p = normalizePath(loc, originHostname);
        if (p) allPaths.push(p);
      }
      emitProgress();
    }

    sitemapOk = allPaths.length > 0;
  } catch (err) {
    console.warn(`[discover] sitemap.xml unavailable for ${cleanOrigin}: ${(err as Error).message}`);
  }

  // --- Fallback to homepage nav scrape ---
  if (!sitemapOk) {
    console.warn(`[discover] falling back to homepage link scrape for ${cleanOrigin}`);
    allPaths = await fallbackFromHomepage(cleanOrigin, originHostname);
  }

  // --- Classify + de-dupe ---
  const corePaths = new Set<string>();
  const ugcPaths = new Set<string>();

  // Root is always present in core
  corePaths.add("/");

  for (const raw of allPaths) {
    const isTaggedUgc = raw.startsWith(UGC_TAG);
    const p = isTaggedUgc ? raw.slice(UGC_TAG.length) : raw;

    if (p === "/") {
      corePaths.add("/");
      continue;
    }

    if (isTaggedUgc || isUgcPath(p)) {
      ugcPaths.add(p);
    } else {
      corePaths.add(p);
    }
  }

  // --- Sort core (/ first, then alpha) ---
  const coreArr = [...corePaths].sort((a, b) => {
    if (a === "/") return -1;
    if (b === "/") return 1;
    return a.localeCompare(b);
  });

  // --- Cap UGC ---
  const ugcArr = [...ugcPaths];
  if (ugcArr.length > ugcLimit) {
    console.warn(
      `[discover] UGC cap: found ${ugcArr.length} UGC pages, keeping first ${ugcLimit} (set ugcLimit to override)`,
    );
    ugcArr.splice(ugcLimit);
  }

  // --- Warn when discovery effectively found only the homepage ---
  if (coreArr.length === 1 && ugcArr.length === 0) {
    console.warn(
      `[discover] discovery found only the homepage for ${cleanOrigin} — sitemap may be empty/inaccessible and nav scrape yielded no links. Only "/" will be built.`,
    );
  }

  // --- Build PageSpec arrays ---
  const toSpec = (route: string): PageSpec => ({
    route,
    dir: pageDir(slug, route),
  });

  emitProgress();

  return {
    core: coreArr.map(toSpec),
    ugc: ugcArr.map(toSpec),
  };
}
