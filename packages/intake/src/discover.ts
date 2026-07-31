export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

import { loadCrawlRules, type CompiledCrawlRules } from "./rules.ts";

let _defaultRules: CompiledCrawlRules | undefined;
export function defaultRules(): CompiledCrawlRules {
  if (!_defaultRules) _defaultRules = loadCrawlRules();
  return _defaultRules;
}

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

export function isUgc(url: string, rules: CompiledCrawlRules = defaultRules()): boolean {
  const u = new URL(url);
  const p = u.pathname.toLowerCase();
  const search = u.search.toLowerCase();
  if (rules.ugcSegments.some((seg) => p.includes(seg))) return true;
  if (rules.datePathRegex.test(p)) return true;
  const params = new URLSearchParams(search);
  for (const key of rules.listingQueryParams) {
    if (params.has(key)) return true;
  }
  return false;
}

export function isNonHtml(url: string, rules: CompiledCrawlRules = defaultRules()): boolean {
  const p = new URL(url).pathname.toLowerCase();
  return rules.nonHtmlExtensions.some((ext) => p.endsWith(ext));
}

export function slugFor(url: string, baseUrl: string): string {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  if (path === "" || url === baseUrl) return "index";
  return path.replace(/\//g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "index";
}

export function priorityFor(url: string, rules: CompiledCrawlRules = defaultRules()): number {
  const path = new URL(url).pathname;
  if (path === "/" || path === "") return rules.homePriority;
  for (const rule of rules.priorityRules) if (rule.regex.test(path)) return rule.priority;
  return rules.defaultPriority;
}

import type { PagesJson, PageInventoryItem } from "@milo/schema";

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

export function buildInventory(input: BuildInventoryInput, rules: CompiledCrawlRules = defaultRules()): PagesJson {
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

  const afterNonHtml = allUrls.filter((u) => !isNonHtml(u, rules));
  const afterUgc = input.includeUgc ? afterNonHtml : afterNonHtml.filter((u) => !isUgc(u, rules));
  const filtered = afterNonHtml.length - afterUgc.length;

  // Dedup by slug (keeps first, homepage wins by priority sort next).
  const bySlug = new Map<string, string>();
  for (const u of afterUgc) {
    const slug = slugFor(u, input.baseUrl);
    if (!bySlug.has(slug)) bySlug.set(slug, u);
  }

  const ranked = [...bySlug.values()]
    .map((url) => ({ url, slug: slugFor(url, input.baseUrl), priority: priorityFor(url, rules), source: sourceOf.get(url) ?? "crawl-discovered" }))
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
    llmBudget: i < rules.fullBudgetCount ? "full" : "truncated",
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
