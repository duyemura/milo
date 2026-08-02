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
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
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

  it("caps at 20 chars for long names", () => {
    const slug = originSlug("https://torrancetraininglab.com/");
    expect(slug.length).toBeLessThanOrEqual(20);
    // "torrancetraininglab" is 19 chars (under the 20-char cap); TLD dropped
    expect(slug).toBe("torrancetraininglab");
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

  it("maps /about/ with prefix from slug", () => {
    expect(pageDir("speakeasyofstrength", "/about/")).toBe("sp-about");
  });

  it("two origins produce different dirs for the same route", () => {
    const a = pageDir("speakeasyofstrength", "/");
    const b = pageDir("torrancetraining", "/");
    expect(a).not.toBe(b);
    expect(a).toBe("sp-home");
    expect(b).toBe("to-home");
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

  it("each PageSpec has a dir namespaced by origin slug prefix", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    const homeSpec = result.core.find((p) => p.route === "/");
    expect(homeSpec).toBeDefined();
    // torrancetraininglab.com → slug "torrancetraining" → prefix "to"
    expect(homeSpec!.dir).toMatch(/^to-/);
    expect(homeSpec!.dir).toContain("home");
  });

  it("blog posts have dir namespaced by same prefix", async () => {
    const result = await discoverPages("https://torrancetraininglab.com");
    for (const p of result.ugc) {
      expect(p.dir).toMatch(/^to-/);
    }
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
    expect(coreRoutes).not.toContain("/monavie-superfood-or-super-rip-off/");
  });

  it("each PageSpec.dir is namespaced by origin prefix 'sp'", async () => {
    const result = await discoverPages("https://speakeasyofstrength.com");
    for (const p of [...result.core, ...result.ugc]) {
      expect(p.dir).toMatch(/^sp-/);
    }
  });

  it("home page dir is sp-home", async () => {
    const result = await discoverPages("https://speakeasyofstrength.com");
    const home = result.core.find((p) => p.route === "/")!;
    expect(home.dir).toBe("sp-home");
  });
});

describe("discoverPages() — ugcLimit cap", () => {
  const MANY_POSTS_URLSET = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset>`,
    `  <url><loc>https://example.com/</loc></url>`,
    `  <url><loc>https://example.com/about/</loc></url>`,
    ...Array.from({ length: 40 }, (_, i) =>
      `  <url><loc>https://example.com/blog/post-${i + 1}/</loc></url>`
    ),
    `</urlset>`,
  ].join("\n");

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
    const coreRoutes = result.core.map((p) => p.route);
    expect(coreRoutes).toContain("/");
    expect(coreRoutes).toContain("/about/");
  });
});

describe("discoverPages() — out-dir namespacing (two origins, same route)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", makeMockFetch({
      "https://speakeasyofstrength.com/sitemap.xml": `<?xml version="1.0"?><urlset><url><loc>https://speakeasyofstrength.com/</loc></url><url><loc>https://speakeasyofstrength.com/about/</loc></url></urlset>`,
      "https://torrancetraininglab.com/sitemap.xml": `<?xml version="1.0"?><urlset><url><loc>https://torrancetraininglab.com/</loc></url><url><loc>https://torrancetraininglab.com/about/</loc></url></urlset>`,
    }));
  });

  it("two different origins produce different dirs for '/'", async () => {
    const a = await discoverPages("https://speakeasyofstrength.com");
    const b = await discoverPages("https://torrancetraininglab.com");
    const aHome = a.core.find((p) => p.route === "/")!.dir;
    const bHome = b.core.find((p) => p.route === "/")!.dir;
    expect(aHome).not.toBe(bHome);
    expect(aHome).toBe("sp-home");
    expect(bHome).toBe("to-home");
  });

  it("two different origins produce different dirs for '/about/'", async () => {
    const a = await discoverPages("https://speakeasyofstrength.com");
    const b = await discoverPages("https://torrancetraininglab.com");
    const aAbout = a.core.find((p) => p.route === "/about/")!.dir;
    const bAbout = b.core.find((p) => p.route === "/about/")!.dir;
    expect(aAbout).not.toBe(bAbout);
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

  it("returns empty UGC when there are no UGC nav links", async () => {
    const result = await discoverPages("https://nogym.example.com");
    expect(result.ugc).toHaveLength(0);
  });
});

describe("discoverPages() — T6: partial sub-sitemap failure (one 503, others succeed)", () => {
  // WordPress sitemap index with 3 sub-sitemaps:
  //   page-sitemap.xml   → succeeds (core pages)
  //   post-sitemap1.xml  → succeeds (UGC pages)
  //   post-sitemap2.xml  → returns 503 (should be skipped, not abort all)
  const WP_INDEX_PARTIAL = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://partial.example.com/page-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://partial.example.com/post-sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://partial.example.com/post-sitemap2.xml</loc></sitemap>
</sitemapindex>`;

  const WP_PAGE = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://partial.example.com/</loc></url>
  <url><loc>https://partial.example.com/about/</loc></url>
  <url><loc>https://partial.example.com/schedule/</loc></url>
</urlset>`;

  const WP_POST1 = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://partial.example.com/strength-training-basics/</loc></url>
  <url><loc>https://partial.example.com/nutrition-for-athletes/</loc></url>
</urlset>`;

  // post-sitemap2.xml is intentionally absent → mock returns 503 for it
  function makeMockFetchWithPartialFailure() {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = url instanceof Request ? url.url : String(url);
      const responses: Record<string, string> = {
        "https://partial.example.com/sitemap.xml": WP_INDEX_PARTIAL,
        "https://partial.example.com/page-sitemap.xml": WP_PAGE,
        "https://partial.example.com/post-sitemap1.xml": WP_POST1,
        // post-sitemap2.xml is missing → 503
      };
      const body = responses[urlStr];
      if (body !== undefined) {
        return { ok: true, status: 200, text: async () => body } as unknown as Response;
      }
      // Everything else (including post-sitemap2.xml) returns 503
      return { ok: false, status: 503, text: async () => "Service Unavailable" } as unknown as Response;
    });
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", makeMockFetchWithPartialFailure());
  });

  it("returns pages from the successful sub-sitemaps (partial.example.com core pages)", async () => {
    const result = await discoverPages("https://partial.example.com");
    const coreRoutes = result.core.map((p) => p.route);
    expect(coreRoutes).toContain("/");
    expect(coreRoutes).toContain("/about/");
    expect(coreRoutes).toContain("/schedule/");
  });

  it("returns UGC pages from the successful post-sitemap1 sub-sitemap", async () => {
    const result = await discoverPages("https://partial.example.com");
    const ugcRoutes = result.ugc.map((p) => p.route);
    expect(ugcRoutes).toContain("/strength-training-basics/");
    expect(ugcRoutes).toContain("/nutrition-for-athletes/");
  });

  it("does NOT include pages from the failed post-sitemap2.xml", async () => {
    // The 503 sub-sitemap contributes nothing, but its absence must not wipe other pages.
    // We verify by checking that we still have the expected total (core + UGC from post1).
    const result = await discoverPages("https://partial.example.com");
    // All pages come from page-sitemap + post-sitemap1; post-sitemap2 adds nothing.
    // If the failed sub-sitemap had caused a full abort, core would be just ["/"].
    expect(result.core.length).toBeGreaterThan(1); // at least / + about + schedule
    expect(result.ugc.length).toBe(2);             // only from post-sitemap1
  });

  it("partial failure does not propagate to crash the full discovery", async () => {
    // Must resolve, not reject.
    await expect(discoverPages("https://partial.example.com")).resolves.toBeDefined();
  });
});
