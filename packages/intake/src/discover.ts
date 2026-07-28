export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Follow redirects and return the canonical origin (`https://host/`). */
export async function normalizeBaseUrl(input: string, fetchLike: FetchLike): Promise<string> {
  try {
    const res = await fetchLike(input, { redirect: "follow" });
    const finalUrl = new URL(res.url || input);
    return `${finalUrl.origin}/`;
  } catch {
    return `${new URL(input).origin}/`;
  }
}

const UGC_SEGMENTS = ["/blog/", "/news/", "/wod/", "/workout/", "/articles/", "/posts/", "/insights/", "/resources/"];
const NON_HTML_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".mp4", ".mov", ".zip", ".woff", ".woff2", ".ttf", ".css", ".js", ".xml", ".ico"];

export function isUgc(url: string): boolean {
  const p = new URL(url).pathname.toLowerCase();
  const search = new URL(url).search.toLowerCase();
  if (UGC_SEGMENTS.some((seg) => p.includes(seg))) return true;
  if (/\/(19|20)\d{2}(\/\d{2})?\//.test(p)) return true;        // /2024/ or /2026/03/
  if (/[?&](p|cat)=/.test(search)) return true;                  // wordpress
  return false;
}

export function isNonHtml(url: string): boolean {
  const p = new URL(url).pathname.toLowerCase();
  return NON_HTML_EXT.some((ext) => p.endsWith(ext));
}

export function slugFor(url: string, baseUrl: string): string {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  if (path === "" || url === baseUrl) return "index";
  return path.replace(/\//g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "index";
}

const PRIORITY_RULES: Array<[RegExp, number]> = [
  [/\/(about|our-story|story|mission)/i, 2],
  [/\/(coaches|team|staff|trainers)/i, 3],
  [/\/(programs|classes|services|training)/i, 4],
  [/\/(pricing|membership|join|rates|plans)/i, 5],
  [/\/(schedule|timetable|calendar)/i, 6],
  [/\/(faq|questions)/i, 7],
  [/\/(contact|location|visit)/i, 8],
];

export function priorityFor(url: string): number {
  const path = new URL(url).pathname;
  if (path === "/" || path === "") return 1;
  for (const [re, score] of PRIORITY_RULES) if (re.test(path)) return score;
  return 9;
}

import type { PagesJson, PageInventoryItem } from "./schemas.ts";

export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

export function extractNavLinks(html: string, baseUrl: string): string[] {
  const navBlocks = [...html.matchAll(/<(?:nav|header)\b[\s\S]*?<\/(?:nav|header)>/gi)].map((m) => m[0]);
  const scope = navBlocks.length ? navBlocks.join("\n") : html;
  const hrefs = [...scope.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const origin = new URL(baseUrl).origin;
  const out: string[] = [];
  for (const href of hrefs) {
    try {
      const abs = new URL(href, baseUrl);
      if (abs.origin === origin && !out.includes(abs.href)) out.push(abs.href);
    } catch { /* skip malformed href */ }
  }
  return out;
}

export interface BuildInventoryInput {
  baseUrl: string;
  sitemapUrls: string[];
  navUrls: string[];
  maxPages: number;
  discoveredAt: string;
  includeUgc?: boolean;
}

const FULL_BUDGET_COUNT = 8;

export function buildInventory(input: BuildInventoryInput): PagesJson {
  const origin = new URL(input.baseUrl).origin;
  const sourceOf = new Map<string, "sitemap" | "nav">();

  for (const u of input.sitemapUrls) if (!sourceOf.has(u)) sourceOf.set(u, "sitemap");
  for (const u of input.navUrls) if (!sourceOf.has(u)) sourceOf.set(u, "nav");

  // Same-origin only (from discovered inputs).
  const sameOrigin = [...sourceOf.keys()].filter((u) => {
    try { return new URL(u).origin === origin; } catch { return false; }
  });

  const totalDiscovered = sameOrigin.length;

  // Guarantee homepage is present after totalDiscovered is recorded.
  if (!sourceOf.has(input.baseUrl)) sourceOf.set(input.baseUrl, "nav");

  const allUrls = [...sourceOf.keys()].filter((u) => {
    try { return new URL(u).origin === origin; } catch { return false; }
  });

  const afterNonHtml = allUrls.filter((u) => !isNonHtml(u));
  const afterUgc = input.includeUgc ? afterNonHtml : afterNonHtml.filter((u) => !isUgc(u));
  const filtered = afterNonHtml.length - afterUgc.length;

  // Dedup by slug (keeps first, homepage wins by priority sort next).
  const bySlug = new Map<string, string>();
  for (const u of afterUgc) {
    const slug = slugFor(u, input.baseUrl);
    if (!bySlug.has(slug)) bySlug.set(slug, u);
  }

  const ranked = [...bySlug.values()]
    .map((url) => ({ url, slug: slugFor(url, input.baseUrl), priority: priorityFor(url), source: sourceOf.get(url) ?? "crawl-discovered" }))
    .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));

  // Pages dropped specifically by the cap = survivors of filtering beyond maxPages.
  // (Not totalDiscovered - maxPages, which would double-count UGC/non-html removals.)
  const capped = Math.max(0, ranked.length - input.maxPages);
  const kept = ranked.slice(0, input.maxPages);

  const pages: PageInventoryItem[] = kept.map((p, i) => ({
    url: p.url,
    slug: p.slug,
    priority: p.priority,
    source: p.source,
    llmBudget: i < FULL_BUDGET_COUNT ? "full" : "truncated",
  }));

  return {
    baseUrl: input.baseUrl,
    discoveredAt: input.discoveredAt,
    totalDiscovered,
    filtered,
    capped,
    pages,
  };
}
