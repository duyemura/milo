# Clone Engine Auto Page-Discovery + Core/UGC Staged Build

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `discoverPages()` (sitemap-based, handles both flat Squarespace urlsets and WordPress sitemap-index), fix the `sp-<route>` out-dir namespacing collision bug, add `buildSiteAuto()` for core-first/UGC staged builds, and wire everything into the CLI and index exports.

**Architecture:** New `src/discover.ts` handles all sitemap fetching + URL classification logic. `orchestrate.ts` gets the out-dir fix and a new `buildSiteAuto()` orchestrator that calls `discoverPages()` then `buildSite()` in two staged passes. CLI gets a `build-auto` subcommand. All test fixtures are in-memory (no network).

**Tech Stack:** Node 24 global `fetch`, AbortSignal.timeout for HTTP, regex-based XML parsing (no external deps), existing `buildSite()`, Vitest for tests.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/clone-engine/src/discover.ts` | **Create** | `discoverPages(origin, opts?)` — fetch sitemap, detect index vs flat, classify core/UGC, fallback to nav scrape |
| `packages/clone-engine/src/orchestrate.ts` | **Modify** | Fix out-dir namespacing (line 106); add `buildSiteAuto()` + its options/result types |
| `packages/clone-engine/src/cli.ts` | **Modify** | Add `build-auto` subcommand |
| `packages/clone-engine/src/index.ts` | **Modify** | Re-export `discoverPages`, `buildSiteAuto`, `BuildSiteAutoOpts`, `BuildSiteAutoResult` |
| `packages/clone-engine/test/discover.test.ts` | **Create** | Unit tests: flat urlset, sitemap-index, classification, ugcLimit cap, out-dir namespacing |

**Do NOT touch:** `packages/clone-engine/src/edit/*` — owned by another agent.

---

### Task 1: Create `src/discover.ts`

**Files:**
- Create: `packages/clone-engine/src/discover.ts`

- [ ] **Step 1: Write the file**

```typescript
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
 *   UGC if path matches /(blog|news|post|posts|article|articles|events|event|resources)/[^/]+
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

const JUNK_PATHS = /^\/(search|cart|checkout|feed|wp-json|wp-login\.php|wp-admin|admin|sitemap[^/]*\.xml)/i;
const JUNK_SEGMENTS = /\/(privacy-policy|terms|terms-of-service|terms-of-use|cookie-policy|legal|gdpr)[/]?$/i;
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
 *      "torrancetraininglab.com" → "torrancetraininglab"
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
 * Build a per-page `dir` slug for a given path, namespaced by origin slug.
 * E.g. origin="speakeasyofstrength.com", route="/" → "se-home"
 *      origin="speakeasyofstrength.com", route="/about/" → "se-about"
 *
 * The origin prefix is the first two characters of the origin slug (de-collision).
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
    html = await fetchText(origin + "/");
  } catch {
    return [];
  }

  // Extract <a href> from nav / header / footer context heuristically — just all <a> tags.
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
 * Each PageSpec.dir is namespaced by origin to avoid multi-site cwd collisions.
 */
export async function discoverPages(
  origin: string,
  opts: DiscoverOpts = {},
): Promise<DiscoverResult> {
  const ugcLimit = opts.ugcLimit ?? 25;
  const originUrl = new URL(origin.replace(/\/$/, "") + "/");
  const originHostname = originUrl.hostname;
  const slug = originSlug(origin);

  let allPaths: string[] = [];

  // --- Try sitemap ---
  let sitemapOk = false;
  try {
    const sitemapXml = await fetchText(`${origin.replace(/\/$/, "")}/sitemap.xml`);

    if (isSitemapIndex(sitemapXml)) {
      // WordPress-style: fetch each sub-sitemap
      const subUrls = extractLocs(sitemapXml).filter((u) => u.endsWith(".xml"));
      for (const subUrl of subUrls) {
        const isUgcSub = /post/i.test(subUrl);
        try {
          const subXml = await fetchText(subUrl);
          const locs = extractLocs(subXml);
          for (const loc of locs) {
            const p = normalizePath(loc, originHostname);
            if (!p) continue;
            // Tag UGC-origin paths: mark them via a sentinel so we can recover
            // their origin after normalization. We encode origin in a tagged form.
            allPaths.push(isUgcSub ? `__ugc__${p}` : p);
          }
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
    }

    sitemapOk = allPaths.length > 0;
  } catch (err) {
    console.warn(`[discover] sitemap.xml unavailable for ${origin}: ${(err as Error).message}`);
  }

  // --- Fallback to homepage nav scrape ---
  if (!sitemapOk) {
    console.warn(`[discover] falling back to homepage link scrape for ${origin}`);
    allPaths = await fallbackFromHomepage(origin, originHostname);
  }

  // --- Classify + de-dupe ---
  const corePaths = new Set<string>();
  const ugcPaths = new Set<string>();

  // Ensure root is always present in core
  corePaths.add("/");

  for (const raw of allPaths) {
    const isTaggedUgc = raw.startsWith("__ugc__");
    const p = isTaggedUgc ? raw.slice("__ugc__".length) : raw;

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

  // --- Build PageSpec arrays ---
  const toSpec = (route: string): PageSpec => ({
    route,
    dir: pageDir(slug, route),
  });

  return {
    core: coreArr.map(toSpec),
    ugc: ugcArr.map(toSpec),
  };
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && node_modules/.bin/tsc --noEmit 2>&1 | head -40
```
Expected: no errors related to discover.ts (there may be pre-existing errors in other files — that's fine as long as discover.ts itself is clean).

- [ ] **Step 3: Commit**

```bash
cd /Users/dan/pushpress/milo && git add packages/clone-engine/src/discover.ts && git commit -m "feat(clone-engine): add discover.ts — sitemap-based page discovery (flat + index)"
```

---

### Task 2: Fix out-dir namespacing in `orchestrate.ts` + add `buildSiteAuto()`

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts`

The current bug is on line 106:
```typescript
out: p.route === "/" ? "sp-home" : "sp-" + p.route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""),
```
Two sites built in the same cwd both map `/` → `sp-home`, colliding.

The fix uses the origin hostname to derive a 2-char prefix (same `originSlug` logic).

- [ ] **Step 1: Import `originSlug` and `pageDir` from discover.ts; fix the out-dir derivation**

In `packages/clone-engine/src/orchestrate.ts`, add the import after the existing imports:

```typescript
import { originSlug, pageDir, discoverPages } from "./discover.ts";
import type { DiscoverOpts } from "./discover.ts";
```

Then change the `augmented` map (currently line 103–107) from:
```typescript
const augmented: AugmentedPage[] = pages.map((p) => ({
  ...p,
  url: origin + p.route,
  out: p.route === "/" ? "sp-home" : "sp-" + p.route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""),
}));
```
To:
```typescript
const slug = originSlug(origin);
const augmented: AugmentedPage[] = pages.map((p) => ({
  ...p,
  url: origin + p.route,
  out: pageDir(slug, p.route),
}));
```

- [ ] **Step 2: Add `BuildSiteAutoOpts`, `BuildSiteAutoResult`, and `buildSiteAuto()` to `orchestrate.ts`**

Append at the bottom of `orchestrate.ts`:

```typescript
// ---------------------------------------------------------------------------
// Auto build: discover → core first → UGC second pass
// ---------------------------------------------------------------------------

export interface BuildSiteAutoOpts extends Omit<BuildSiteOpts, "pages"> {
  /** 'core' builds only core pages (default). 'full' adds a second UGC pass. */
  mode?: "core" | "full";
  /** Pass-through to discoverPages ugcLimit (default 25). */
  ugcLimit?: number;
  /** Report output path for the core pass. */
  coreReportOut?: string;
  /** Report output path for the UGC pass (only used when mode==='full'). */
  ugcReportOut?: string;
}

export interface BuildSiteAutoResult {
  core: BuildSiteResult;
  ugc?: BuildSiteResult;
}

/**
 * Auto-discover pages via sitemap and build in staged passes:
 *   1. Core pages (always) — a coherent publishable site.
 *   2. UGC pages (when mode==='full') — blog/news follow-up pass.
 *
 * `buildSite()` is unchanged; this function orchestrates on top of it.
 */
export async function buildSiteAuto(
  origin: string,
  opts: BuildSiteAutoOpts = {},
): Promise<BuildSiteAutoResult> {
  const { mode = "core", ugcLimit, coreReportOut, ugcReportOut, ...buildOpts } = opts;

  console.log(`[build-auto] Discovering pages for ${origin}...`);
  const discovered = await discoverPages(origin, { ugcLimit });
  console.log(
    `[build-auto] Found ${discovered.core.length} core pages, ${discovered.ugc.length} UGC pages`,
  );
  console.log(`[build-auto] Core: ${discovered.core.map((p) => p.route).join("  ")}`);
  if (discovered.ugc.length > 0) {
    console.log(`[build-auto] UGC (${discovered.ugc.length}): ${discovered.ugc.slice(0, 5).map((p) => p.route).join("  ")}${discovered.ugc.length > 5 ? " …" : ""}`);
  }

  // --- Core pass ---
  console.log(`\n[build-auto] === CORE PASS (${discovered.core.length} pages) ===`);
  const coreResult = await buildSite({
    ...buildOpts,
    origin,
    pages: discovered.core,
    reportOut: coreReportOut ?? opts.reportOut,
  });

  // --- UGC pass (only when mode==='full') ---
  let ugcResult: BuildSiteResult | undefined;
  if (mode === "full" && discovered.ugc.length > 0) {
    console.log(`\n[build-auto] === UGC PASS (${discovered.ugc.length} pages) ===`);
    ugcResult = await buildSite({
      ...buildOpts,
      origin,
      pages: discovered.ugc,
      reportOut: ugcReportOut,
    });
  } else if (mode === "full" && discovered.ugc.length === 0) {
    console.log(`[build-auto] No UGC pages found — skipping UGC pass`);
  }

  return { core: coreResult, ugc: ugcResult };
}
```

- [ ] **Step 3: Verify typecheck clean**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && node_modules/.bin/tsc --noEmit 2>&1 | head -40
```
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
cd /Users/dan/pushpress/milo && git add packages/clone-engine/src/orchestrate.ts && git commit -m "fix(clone-engine): origin-namespaced out-dirs (sp- collision bug) + buildSiteAuto()"
```

---

### Task 3: Wire `build-auto` subcommand into `cli.ts`

**Files:**
- Modify: `packages/clone-engine/src/cli.ts`

- [ ] **Step 1: Add the import and new subcommand**

Add `buildSiteAuto` to the import from orchestrate:
```typescript
import { buildSite, buildSiteAuto } from "./orchestrate.ts";
```

Add `build-auto` to the boolean flags set and to the BOOLEAN_FLAGS set (it has no boolean flags, so no change needed). Add the case in the switch:

```typescript
case "build-auto": {
  // node src/cli.ts build-auto --site <origin> [--mode core|full] [--out <report.html>] [--cwd <dir>] [--ugc-limit <n>]
  const site = requireArg("site");
  const mode = (arg("mode", "core") as "core" | "full");
  const reportOut = arg("out");
  const buildCwd = arg("cwd", process.cwd());
  const ugcLimitStr = arg("ugc-limit");
  const ugcLimit = ugcLimitStr ? parseInt(ugcLimitStr, 10) : undefined;

  await buildSiteAuto(site, {
    cwd: buildCwd,
    mode,
    reportOut,
    ugcLimit,
  });
  break;
}
```

Also update the usage/error message to include `build-auto`:
```typescript
console.error("Usage: node src/cli.ts <capture|label|project|build|build-site|build-auto|deploy> [--engine <ts|mjs>] [flags]");
```
And update the default case error:
```typescript
console.error("Valid subcommands: capture, label, project, build, build-site, build-auto, deploy");
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && node_modules/.bin/tsc --noEmit 2>&1 | head -40
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/dan/pushpress/milo && git add packages/clone-engine/src/cli.ts && git commit -m "feat(clone-engine): add build-auto CLI subcommand (discover + staged core/UGC)"
```

---

### Task 4: Update `index.ts` exports

**Files:**
- Modify: `packages/clone-engine/src/index.ts`

- [ ] **Step 1: Add the new exports**

After the `crawlSite` export line, add:
```typescript
export { discoverPages, originSlug, pageDir } from "./discover.ts";
export type { DiscoverOpts, DiscoverResult } from "./discover.ts";
export { buildSiteAuto } from "./orchestrate.ts";
export type { BuildSiteAutoOpts, BuildSiteAutoResult } from "./orchestrate.ts";
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && node_modules/.bin/tsc --noEmit 2>&1 | head -40
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/dan/pushpress/milo && git add packages/clone-engine/src/index.ts && git commit -m "feat(clone-engine): re-export discoverPages, buildSiteAuto from index.ts"
```

---

### Task 5: Write `test/discover.test.ts`

**Files:**
- Create: `packages/clone-engine/test/discover.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
/**
 * discover.test.ts — unit tests for discoverPages(), originSlug(), pageDir().
 *
 * No network: all fetch calls are mocked via vi.stubGlobal("fetch", ...).
 * Fixtures are inline XML strings (flat urlset + sitemap index + sub-sitemaps).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { discoverPages, originSlug, pageDir } from "../src/discover.ts";

// ---------------------------------------------------------------------------
// Fixture XML strings
// ---------------------------------------------------------------------------

/** Squarespace-style flat urlset */
const FLAT_URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://torrancetraininglab.com/</loc></url>
  <url><loc>https://torrancetraininglab.com/about/</loc></url>
  <url><loc>https://torrancetraininglab.com/schedule/</loc></url>
  <url><loc>https://torrancetraininglab.com/contact/</loc></url>
  <url><loc>https://torrancetraininglab.com/membership-pricing/</loc></url>
  <url><loc>https://torrancetraininglab.com/coaches/</loc></url>
  <url><loc>https://torrancetraininglab.com/blog/getting-started-with-crossfit/</loc></url>
  <url><loc>https://torrancetraininglab.com/blog/nutrition-tips-for-athletes/</loc></url>
  <url><loc>https://torrancetraininglab.com/blog/how-to-recover-faster/</loc></url>
  <url><loc>https://torrancetraininglab.com/privacy-policy/</loc></url>
  <url><loc>https://torrancetraininglab.com/search</loc></url>
  <url><loc>https://torrancetraininglab.com/cart</loc></url>
</urlset>`;

/** WordPress sitemap index */
const WP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://speakeasyofstrength.com/page-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://speakeasyofstrength.com/post-sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://speakeasyofstrength.com/post-sitemap2.xml</loc></sitemap>
  <sitemap><loc>https://speakeasyofstrength.com/category-sitemap.xml</loc></sitemap>
</sitemapindex>`;

const WP_PAGE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://speakeasyofstrength.com/</loc></url>
  <url><loc>https://speakeasyofstrength.com/about/</loc></url>
  <url><loc>https://speakeasyofstrength.com/testimonials/</loc></url>
  <url><loc>https://speakeasyofstrength.com/locations/</loc></url>
</urlset>`;

const WP_POST_SITEMAP1 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://speakeasyofstrength.com/reasons-you-gain-weight-vacation/</loc></url>
  <url><loc>https://speakeasyofstrength.com/ladies-optimal-fuel-workouts-nutrient/</loc></url>
</urlset>`;

const WP_POST_SITEMAP2 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://speakeasyofstrength.com/monavie-superfood-or-super-rip-off/</loc></url>
</urlset>`;

const WP_CATEGORY_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://speakeasyofstrength.com/category/nutrition/</loc></url>
</urlset>`;

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function makeMockFetch(responses: Record<string, string>) {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : String(url);
    const body = responses[urlStr];
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        text: async () => "Not Found",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("AbortSignal", {
    timeout: () => ({ aborted: false }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("originSlug()", () => {
  it("strips www. and TLD for multi-part domain", () => {
    expect(originSlug("https://www.ksathleticclub.com")).toBe("ksathleticclub");
  });

  it("strips TLD for non-www domain", () => {
    expect(originSlug("https://speakeasyofstrength.com")).toBe("speakeasyofstrength");
  });

  it("handles trailing slash in origin", () => {
    expect(originSlug("https://torrancetraininglab.com/")).toBe("torrancetraining");
  });

  it("two different origins produce different slugs", () => {
    const a = originSlug("https://speakeasyofstrength.com");
    const b = originSlug("https://torrancetraininglab.com");
    expect(a).not.toBe(b);
  });
});

describe("pageDir()", () => {
  it("maps / to <prefix>-home", () => {
    expect(pageDir("speakeasyofstrength", "/")).toBe("sp-home");
  });

  it("maps /about/ to <prefix>-about", () => {
    expect(pageDir("speakeasyofstrength", "/about/")).toBe("sp-about");
  });

  it("two origins produce different dirs for the same route", () => {
    const a = pageDir("speakeasyofstrength", "/");
    const b = pageDir("torrancetraininglab", "/");
    expect(a).not.toBe(b);
  });
});

describe("discoverPages() — flat Squarespace urlset", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeMockFetch({
      "https://torrancetraininglab.com/sitemap.xml": FLAT_URLSET,
    }));
  });

  it("puts / first in core", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    expect(result.core[0].route).toBe("/");
  });

  it("classifies blog/* as UGC", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    const ugcRoutes = result.ugc.map((p) => p.route);
    expect(ugcRoutes).toContain("/blog/getting-started-with-crossfit/");
    expect(ugcRoutes).toContain("/blog/nutrition-tips-for-athletes/");
    expect(ugcRoutes).toContain("/blog/how-to-recover-faster/");
  });

  it("classifies /about/, /schedule/, /contact/ as core", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    const coreRoutes = result.core.map((p) => p.route);
    expect(coreRoutes).toContain("/about/");
    expect(coreRoutes).toContain("/schedule/");
    expect(coreRoutes).toContain("/contact/");
  });

  it("excludes /privacy-policy/ from both core and UGC", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    const all = [...result.core, ...result.ugc].map((p) => p.route);
    expect(all).not.toContain("/privacy-policy/");
  });

  it("excludes /search and /cart from both core and UGC", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    const all = [...result.core, ...result.ugc].map((p) => p.route);
    expect(all.some((r) => r.includes("search"))).toBe(false);
    expect(all.some((r) => r.includes("cart"))).toBe(false);
  });

  it("each PageSpec has a dir namespaced by origin slug", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    const homeSpec = result.core.find((p) => p.route === "/");
    expect(homeSpec).toBeDefined();
    // Should be "to-home" (slug is "torrancetraining" → prefix "to")
    expect(homeSpec!.dir).toMatch(/^to-/);
    expect(homeSpec!.dir).toContain("home");
  });
});

describe("discoverPages() — WordPress sitemap-index", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeMockFetch({
      "https://speakeasyofstrength.com/sitemap.xml": WP_INDEX,
      "https://speakeasyofstrength.com/page-sitemap.xml": WP_PAGE_SITEMAP,
      "https://speakeasyofstrength.com/post-sitemap1.xml": WP_POST_SITEMAP1,
      "https://speakeasyofstrength.com/post-sitemap2.xml": WP_POST_SITEMAP2,
      "https://speakeasyofstrength.com/category-sitemap.xml": WP_CATEGORY_SITEMAP,
    }));
  });

  it("puts / first in core", async () => {
    const result = await discoverPages("https://speakeasyofstrength.com");
    expect(result.core[0].route).toBe("/");
  });

  it("classifies page-sitemap URLs as core", async () => {
    const result = await discoverPages("https://speakeasyofstrength.com");
    const coreRoutes = result.core.map((p) => p.route);
    expect(coreRoutes).toContain("/about/");
    expect(coreRoutes).toContain("/testimonials/");
    expect(coreRoutes).toContain("/locations/");
  });

  it("classifies post-sitemap1 + post-sitemap2 URLs as UGC", async () => {
    const result = await discoverPages("https://speakeasyofstrength.com");
    const ugcRoutes = result.ugc.map((p) => p.route);
    expect(ugcRoutes).toContain("/reasons-you-gain-weight-vacation/");
    expect(ugcRoutes).toContain("/ladies-optimal-fuel-workouts-nutrient/");
    expect(ugcRoutes).toContain("/monavie-superfood-or-super-rip-off/");
  });

  it("WP post-sitemap pages are NOT in core", async () => {
    const result = await discoverPages("https://speakeasyofstrength.com");
    const coreRoutes = result.core.map((p) => p.route);
    expect(coreRoutes).not.toContain("/reasons-you-gain-weight-vacation/");
  });

  it("each PageSpec.dir is namespaced by origin (prefix 'sp')", async () => {
    const result = await discoverPages("https://speakeasyofstrength.com");
    const home = result.core.find((p) => p.route === "/");
    expect(home).toBeDefined();
    expect(home!.dir).toMatch(/^sp-/);
  });
});

describe("discoverPages() — ugcLimit cap", () => {
  const MANY_POSTS_URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about/</loc></url>
  ${Array.from({ length: 40 }, (_, i) => `<url><loc>https://example.com/blog/post-${i + 1}/</loc></url>`).join("\n  ")}
</urlset>`;

  beforeEach(() => {
    vi.stubGlobal("fetch", makeMockFetch({
      "https://example.com/sitemap.xml": MANY_POSTS_URLSET,
    }));
  });

  it("caps UGC at ugcLimit (default 25)", async () => {
    const result = await discoverPages("https://example.com");
    expect(result.ugc.length).toBe(25);
  });

  it("returns full UGC when ugcLimit is raised", async () => {
    const result = await discoverPages("https://example.com", { ugcLimit: 50 });
    expect(result.ugc.length).toBe(40);
  });

  it("core pages are unaffected by ugcLimit", async () => {
    const result = await discoverPages("https://example.com");
    expect(result.core.map((p) => p.route)).toContain("/about/");
  });
});

describe("discoverPages() — out-dir namespacing (two origins, same route)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeMockFetch({
      "https://speakeasyofstrength.com/sitemap.xml": `<?xml version="1.0"?><urlset><url><loc>https://speakeasyofstrength.com/</loc></url></urlset>`,
      "https://torrancetraininglab.com/sitemap.xml": `<?xml version="1.0"?><urlset><url><loc>https://torrancetraininglab.com/</loc></url></urlset>`,
    }));
  });

  it("two different origins produce different dirs for '/'", async () => {
    const a = await discoverPages("https://speakeasyofstrength.com");
    const b = await discoverPages("https://torrancetraininglab.com");
    const aHome = a.core.find((p) => p.route === "/")!.dir;
    const bHome = b.core.find((p) => p.route === "/")!.dir;
    expect(aHome).not.toBe(bHome);
  });
});

describe("discoverPages() — sitemap 404 fallback", () => {
  beforeEach(() => {
    // sitemap.xml returns 404; homepage has nav links
    vi.stubGlobal("fetch", makeMockFetch({
      "https://nogym.example.com/": `<html><body><nav><a href="/about/">About</a><a href="/schedule/">Schedule</a></nav></body></html>`,
    }));
  });

  it("falls back to homepage nav scrape when sitemap is unavailable", async () => {
    const result = await discoverPages("https://nogym.example.com");
    const routes = result.core.map((p) => p.route);
    expect(routes).toContain("/about/");
    expect(routes).toContain("/schedule/");
  });

  it("always includes / in core even when no sitemap", async () => {
    const result = await discoverPages("https://nogym.example.com");
    expect(result.core[0].route).toBe("/");
  });
});
```

- [ ] **Step 2: Run the tests to see they pass**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run --no-file-parallelism test/discover.test.ts 2>&1 | tail -30
```
Expected: all tests in discover.test.ts pass (some may initially fail if there are small mismatches — fix them inline).

- [ ] **Step 3: Run the full test suite to make sure existing tests are green**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run --no-file-parallelism 2>&1 | tail -30
```
Expected: all tests pass.

- [ ] **Step 4: Final typecheck**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && node_modules/.bin/tsc --noEmit 2>&1 | head -40
```
Expected: clean.

- [ ] **Step 5: Commit everything**

```bash
cd /Users/dan/pushpress/milo && git add packages/clone-engine/test/discover.test.ts && git commit -m "test(clone-engine): discover.test.ts — flat urlset, WP index, classification, ugcLimit, namespacing"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Covered by |
|-------------|-----------|
| `discoverPages(origin, opts?) → { core, ugc }` | Task 1: discover.ts |
| Flat sitemap urlset (Squarespace) | Task 1: `isSitemapIndex` = false branch |
| Sitemap-index (WordPress) | Task 1: `isSitemapIndex` = true branch, fetch sub-sitemaps |
| Post-* sub-sitemap → UGC-tagged | Task 1: `isUgcSub` check on sub-sitemap URL |
| Fallback to homepage nav scrape | Task 1: `fallbackFromHomepage()` |
| UGC classification regex | Task 1: `UGC_PATTERN` constant |
| Junk exclusion (/search, /cart, /privacy-policy, /terms, .xml, feeds) | Task 1: `JUNK_PATHS` + `JUNK_SEGMENTS` + ext check |
| De-dup by normalized path | Task 1: `Set<string>` for core/ugc |
| `ugcLimit` cap with LOG | Task 1: `console.warn` + `ugcArr.splice(ugcLimit)` |
| Origin-namespaced `dir` per PageSpec | Task 1: `pageDir(originSlug, route)` |
| `sp-<route>` bug fixed | Task 2: `pageDir()` replaces hardcoded `sp-` prefix |
| `buildSiteAuto()` with core/full modes | Task 2: appended to orchestrate.ts |
| `build-auto` CLI subcommand | Task 3: cli.ts |
| `discoverPages`, `buildSiteAuto` re-exported from index | Task 4: index.ts |
| Tests: flat urlset + WP index + classification | Task 5: discover.test.ts |
| Tests: ugcLimit cap logs + truncates | Task 5: "ugcLimit cap" describe block |
| Tests: two origins → different dirs | Task 5: "out-dir namespacing" describe block |
| Existing suite stays green | Task 5: full suite run |
| tsc --noEmit clean | Tasks 1–5: typecheck steps |

**Placeholder scan:** None found — all code blocks are complete.

**Type consistency check:** `PageSpec` is imported from `orchestrate.ts` in `discover.ts`. `DiscoverOpts`/`DiscoverResult` are defined in `discover.ts` and re-exported from `index.ts`. `BuildSiteAutoOpts`/`BuildSiteAutoResult` extend/reuse `BuildSiteOpts`/`BuildSiteResult` from same file. All names consistent across tasks.
