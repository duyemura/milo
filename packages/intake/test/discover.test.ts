import { describe, it, expect } from "vitest";
import { normalizeBaseUrl, isUgc, isNonHtml, slugFor, priorityFor } from "../src/discover.ts";
import { parseSitemap, extractNavLinks, buildInventory } from "../src/discover.ts";
import { compileCrawlRules } from "../src/rules.ts";
import type { CrawlRules } from "../src/rules.ts";

describe("normalizeBaseUrl", () => {
  it("follows redirects and returns the final origin with trailing slash", async () => {
    const fetchLike = async (url: string) =>
      ({ url: "https://ironanchor.com/", ok: true, status: 200 }) as unknown as Response;
    expect(await normalizeBaseUrl("http://www.ironanchor.com", fetchLike)).toBe("https://ironanchor.com/");
  });

  it("falls back to the input origin when the fetch throws", async () => {
    const fetchLike = async () => { throw new Error("network"); };
    expect(await normalizeBaseUrl("https://gym.io/some/path", fetchLike)).toBe("https://gym.io/");
  });
});

describe("isUgc", () => {
  it("flags blog/news/date/wordpress patterns", () => {
    expect(isUgc("https://g.com/blog/how-to")).toBe(true);
    expect(isUgc("https://g.com/2024/03/post")).toBe(true);
    expect(isUgc("https://g.com/?p=42")).toBe(true);
    expect(isUgc("https://g.com/wod/monday")).toBe(true);
  });
  it("does not flag core pages", () => {
    expect(isUgc("https://g.com/about")).toBe(false);
    expect(isUgc("https://g.com/pricing")).toBe(false);
  });
});

describe("isNonHtml", () => {
  it("flags binary extensions", () => {
    expect(isNonHtml("https://g.com/menu.pdf")).toBe(true);
    expect(isNonHtml("https://g.com/hero.jpg")).toBe(true);
    expect(isNonHtml("https://g.com/promo.mp4")).toBe(true);
  });
  it("passes html-ish urls", () => {
    expect(isNonHtml("https://g.com/coaches")).toBe(false);
    expect(isNonHtml("https://g.com/")).toBe(false);
  });
});

describe("slugFor", () => {
  it("derives a slug from the path, homepage -> index", () => {
    expect(slugFor("https://g.com/", "https://g.com/")).toBe("index");
    expect(slugFor("https://g.com/our-coaches/", "https://g.com/")).toBe("our-coaches");
    expect(slugFor("https://g.com/programs/crossfit", "https://g.com/")).toBe("programs-crossfit");
  });
});

describe("priorityFor", () => {
  it("ranks core pages ahead of misc", () => {
    expect(priorityFor("https://g.com/")).toBe(1);
    expect(priorityFor("https://g.com/about")).toBe(2);
    expect(priorityFor("https://g.com/coaches")).toBe(3);
    expect(priorityFor("https://g.com/programs")).toBe(4);
    expect(priorityFor("https://g.com/pricing")).toBe(5);
    expect(priorityFor("https://g.com/random-thing")).toBe(9);
  });
});

describe("parseSitemap", () => {
  it("extracts <loc> urls", () => {
    const xml = `<urlset><url><loc>https://g.com/</loc></url><url><loc>https://g.com/about</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual(["https://g.com/", "https://g.com/about"]);
  });
});

describe("extractNavLinks", () => {
  it("pulls same-origin hrefs from nav/header", () => {
    const html = `<header><nav><a href="/about">About</a><a href="https://g.com/coaches">Coaches</a>
      <a href="https://facebook.com/g">FB</a></nav></header>`;
    expect(extractNavLinks(html, "https://g.com/")).toEqual(["https://g.com/about", "https://g.com/coaches"]);
  });
});

const CUSTOM_RULES = compileCrawlRules({
  version: 1,
  ugcSegments: ["/podcast/"],
  datePathRegex: "/\\/(19|20)\\d{2}(\\/\\d{2})?\\//",
  listingQueryParams: ["page"],
  nonHtmlExtensions: [".pdf"],
  priorityRules: [{ pattern: "/(nutrition|meal-plan)/", priority: 2 }],
  homePriority: 1,
  defaultPriority: 9,
  fullBudgetCount: 4,
} as CrawlRules);

describe("custom crawl rules", () => {
  it("uses configured UGC segments and non-html extensions", () => {
    expect(isUgc("https://g.com/podcast/episode-1", CUSTOM_RULES)).toBe(true);
    expect(isUgc("https://g.com/blog/post", CUSTOM_RULES)).toBe(false); // not in custom rules
    expect(isNonHtml("https://g.com/menu.pdf", CUSTOM_RULES)).toBe(true);
    expect(isNonHtml("https://g.com/hero.jpg", CUSTOM_RULES)).toBe(false); // not in custom rules
  });
  it("uses configured priority rules and full-budget count", () => {
    expect(priorityFor("https://g.com/nutrition", CUSTOM_RULES)).toBe(2);
    expect(priorityFor("https://g.com/", CUSTOM_RULES)).toBe(1);
    expect(priorityFor("https://g.com/random", CUSTOM_RULES)).toBe(9);
    const inv = buildInventory({
      baseUrl: "https://g.com/",
      sitemapUrls: Array.from({ length: 10 }, (_, i) => `https://g.com/p${i}`),
      navUrls: [],
      maxPages: 10,
      discoveredAt: "t",
    }, CUSTOM_RULES);
    expect(inv.pages.filter((p) => p.llmBudget === "full").length).toBe(4);
  });
});

describe("buildInventory", () => {
  it("merges, filters UGC + non-html, prioritizes, caps, and budgets", () => {
    const inv = buildInventory({
      baseUrl: "https://g.com/",
      sitemapUrls: ["https://g.com/", "https://g.com/blog/post-1", "https://g.com/menu.pdf", "https://g.com/pricing"],
      navUrls: ["https://g.com/about", "https://g.com/coaches"],
      maxPages: 25,
      discoveredAt: "2026-07-28T00:00:00Z",
    });
    const slugs = inv.pages.map((p) => p.slug);
    expect(slugs[0]).toBe("index");                 // homepage first
    expect(slugs).toContain("about");
    expect(slugs).toContain("pricing");
    expect(slugs).not.toContain("post-1");          // UGC removed
    expect(slugs).not.toContain("menu");            // non-html removed
    expect(inv.filtered).toBe(1);                   // one UGC page
    expect(inv.pages.every((p) => p.priority >= 1 && p.priority <= 9)).toBe(true);
    expect(inv.pages[0].llmBudget).toBe("full");
  });

  it("caps at maxPages and records the drop count", () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://g.com/p${i}`);
    const inv = buildInventory({ baseUrl: "https://g.com/", sitemapUrls: many, navUrls: [], maxPages: 10, discoveredAt: "t" });
    expect(inv.pages.length).toBe(10);
    // 30 sitemap URLs + auto-injected homepage = 31 ranked; 10 kept → 21 dropped by cap.
    expect(inv.capped).toBe(21);
    expect(inv.pages.filter((p) => p.llmBudget === "full").length).toBe(8);   // top 8 full
  });
});
