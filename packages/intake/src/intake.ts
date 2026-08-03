import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type StorageAdapter } from "@milo/storage";
import { DocStore, resolveDocStore } from "./doc-store.ts";
import { consoleLogger, type MiloLogger } from "./logger.ts";
import { PagesJson, PageDocument, BrandCrawl, IdentityCrawl } from "@milo/schema";
import type { PlacesClient } from "./places.ts";
import { placesToIdentity } from "./places.ts";
import type { PageFetcher } from "./crawl.ts";
import { extractPageDocument, downloadAsset, captureFontsWithPlaywright, sanitizeAssetName } from "./crawl.ts";
import { normalizeBaseUrl, parseSitemap, extractNavLinks, buildInventory, slugFor, priorityFor } from "./discover.ts";
import type { FetchLike } from "./discover.ts";
import { nextToCrawl, buildLinkMap } from "./crawl-graph.ts";
import { extractColors, extractFonts, extractLogo, extractSocialLinks, fingerprintSoftware, detectAnalytics } from "./brand.ts";
import { classifyPage, classifyBusiness, buildIntegrations } from "./classify.ts";
import { analyzeContext } from "./context.ts";
import { generateSite } from "@milo/generate";
import type { ChatFn } from "@milo/llm";
import { loadCrawlRules, type CompiledCrawlRules } from "./rules.ts";
import { createRealSocialScraper, type SocialScraper, type SocialProfile } from "./social.ts";

export interface RunLearnResult {
  context: Record<string, unknown>;
  business: Record<string, unknown>;
  identity: IdentityCrawl;
  brand: BrandCrawl;
  gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[];
  integrations: Record<string, unknown>;
  /** URI of the docs root everything was written to, e.g. file:///Users/x/.milo/gyms/<slug>/docs */
  docsUri: string;
}

export interface RunLearnOptions {
  url: string;
  /** Business name for GMB query. Defaults to hostname if omitted. */
  gymName: string;
  /** City hint for GMB lookup. */
  city: string;
  /** State hint for GMB lookup. */
  state: string;
  /** Country code. Defaults to US. */
  country: string;
  /** When set, docs are written to this local dir instead of the default storage backend. */
  outDir?: string;
  /** How many key nav pages to fetch beyond the homepage (default: 4). */
  keyPageLimit?: number;
  concurrency: number;
  places: PlacesClient;
  fetcher: PageFetcher;
  chat: ChatFn;
  capableModel: string;
  fastModel: string;
  normalizeFetch?: FetchLike;
  discoveredAt: string;
  captureFonts?: (url: string) => Promise<{ display: string; body: string } | null>;
  downloadOne?: (url: string, assetsDir: string, preferredName?: string) => Promise<string | null>;
  gmbPhotoMaxWidthPx?: number;
  socialScraper?: SocialScraper;
  storage?: StorageAdapter;
  slug?: string;
  logger?: MiloLogger;
}

export interface RunIntakeOptions extends RunLearnOptions {
  maxPages: number;
  includeUgc: boolean;
  skipCrawl?: boolean;
  rules?: CompiledCrawlRules;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Download every unique image referenced by crawled pages. Returns original URL → local path. */
async function downloadPageAssets(
  pages: PageDocument[],
  assetsDir: string,
  downloadOne: (url: string, assetsDir: string, preferredName?: string) => Promise<string | null> = downloadAsset,
  logger?: MiloLogger,
): Promise<Record<string, string>> {
  const uniqueUrls = [...new Set(pages.flatMap((p) => p.images.map((i) => i.src)))];
  const results = await mapWithConcurrency(uniqueUrls, 5, async (url) => {
    const local = await downloadOne(url, assetsDir);
    if (local) logger?.verbose(`[learn] asset ${url} → ${local}`);
    return { url, local };
  });
  const map: Record<string, string> = {};
  for (const { url, local } of results) {
    if (local) map[url] = local;
  }
  return map;
}

/** Attach downloaded local paths to page images while keeping src as the original URL. */
function attachLocalAssetPaths(pages: PageDocument[], assetMap: Record<string, string>): void {
  for (const page of pages) {
    for (const img of page.images) {
      const local = assetMap[img.src];
      if (local) {
        img.localPath = local;  // local /assets/... path consumed by renderer
      }
    }
  }
}

interface DownloadedGmbAsset {
  name: string;
  source: "gmb";
  localPath: string;
  widthPx?: number;
  heightPx?: number;
  attribution?: string;
}

/** Download the best available GMB photos into assetsDir. Returns resource name → local path. */
async function downloadGmbPhotos(
  identity: IdentityCrawl,
  assetsDir: string,
  getPhotoUri: (photoName: string, maxWidthPx?: number) => Promise<string | null>,
  downloadOne: (url: string, assetsDir: string, preferredName?: string) => Promise<string | null> = downloadAsset,
  maxWidthPx = 1600,
  logger?: MiloLogger,
): Promise<DownloadedGmbAsset[]> {
  if (!identity.photos || identity.photos.length === 0) return [];
  // Take top photos by resolution; keep attribution. Don't hammer the API.
  const candidates = identity.photos
    .filter((p) => p.name)
    .slice(0, 8)
    .sort((a, b) => (b.widthPx ?? 0) - (a.widthPx ?? 0));

  const assets: DownloadedGmbAsset[] = [];
  for (const photo of candidates) {
    const uri = await getPhotoUri(photo.name, maxWidthPx);
    if (!uri) continue;
    // Use a stable local name derived from the Places photo resource name.
    const localName = `gmb-${sanitizeAssetName(`https://places.googleapis.com/v1/${photo.name}`)}`;
    const saved = await downloadOne(uri, assetsDir, localName);
    if (saved) {
      logger?.verbose(`[learn] gmb photo ${photo.name} → ${saved}`);
      assets.push({
        name: photo.name,
        source: "gmb",
        localPath: saved,
        widthPx: photo.widthPx,
        heightPx: photo.heightPx,
        attribution: photo.authorAttributions?.map((a) => a.displayName).join(", "),
      });
    }
  }
  return assets;
}

const STANDARD_ARCHETYPES = ["about", "coaches", "programs", "pricing", "contact"] as const;

/** Map a classified page to a canonical placeholder archetype if it covers one. */
function coveredArchetype(page: PageDocument): string | null {
  const a = page.pageArchetype.toLowerCase();
  const slug = page.slug.toLowerCase();
  if (a === "home" || slug === "index") return null;
  if (a.includes("about") || slug.includes("about") || slug.includes("story") || slug.includes("mission")) return "about";
  if (a.includes("coach") || a.includes("team") || a.includes("staff") || slug.includes("coach") || slug.includes("team") || slug.includes("staff")) return "coaches";
  if (a.includes("program") || a.includes("class") || a.includes("service") || a.includes("training") || slug.includes("program") || slug.includes("class") || slug.includes("service") || slug.includes("training")) return "programs";
  if (a.includes("pricing") || a.includes("membership") || a.includes("join") || a.includes("rate") || slug.includes("pricing") || slug.includes("membership") || slug.includes("join") || slug.includes("rate")) return "pricing";
  if (a.includes("contact") || a.includes("location") || a.includes("visit") || slug.includes("contact") || slug.includes("location") || slug.includes("visit")) return "contact";
  return null;
}

/** Which standard gym archetypes have no real crawl doc yet. */
function missingArchetypes(pages: PageDocument[]): string[] {
  const covered = new Set<string>();
  for (const p of pages) {
    const cat = coveredArchetype(p);
    if (cat) covered.add(cat);
  }
  return STANDARD_ARCHETYPES.filter((a) => !covered.has(a));
}

/** Best-effort scrape of the social links found on the homepage. */
async function scrapeSocialProfiles(
  socialLinks: string[],
  scraper: SocialScraper | undefined,
): Promise<SocialProfile[]> {
  if (!scraper) return [];
  const profiles: SocialProfile[] = [];
  for (const url of socialLinks) {
    let platform: string | null = null;
    if (/instagram\.com/i.test(url)) platform = "instagram";
    if (!platform) continue;
    const profile = await scraper.scrape(url, platform);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

/** Append social profile text to the homepage body so context/business LLMs see it. */
function enrichHomepageWithSocial(pageDocs: PageDocument[], profiles: SocialProfile[]): void {
  if (profiles.length === 0) return;
  const home = pageDocs.find((p) => p.slug === "index");
  if (!home) return;
  const socialText = profiles.map((p) => `[${p.platform} @${p.handle}] ${p.bio}\n${p.recentPosts.join("\n")}`).join("\n\n");
  home.bodyText = `${home.bodyText}\n\n--- Social profiles ---\n${socialText}`.trim();
}

function contextToMarkdown(gymName: string, ctx: Record<string, unknown>): string {
  const lines: string[] = [`# Context: ${gymName}`, ""];
  const icp = ctx["icp"] as Record<string, unknown> | undefined;
  if (icp) {
    lines.push("## Ideal customer profile");
    if (icp["fitnessLevel"]) lines.push(`- Fitness level: ${icp["fitnessLevel"]}`);
    if (icp["ageRange"]) lines.push(`- Age range: ${icp["ageRange"]}`);
    if (Array.isArray(icp["primaryGoals"]) && icp["primaryGoals"].length) lines.push(`- Goals: ${icp["primaryGoals"].join(", ")}`);
    lines.push("");
  }
  const voice = ctx["brandVoice"] as Record<string, unknown> | undefined;
  if (voice) {
    lines.push("## Brand voice");
    if (voice["tone"]) lines.push(`- Tone: ${voice["tone"]}`);
    if (voice["communicationStyle"]) lines.push(`- Style: ${voice["communicationStyle"]}`);
    if (Array.isArray(voice["emphasizes"]) && voice["emphasizes"].length) lines.push(`- Emphasizes: ${voice["emphasizes"].join(", ")}`);
    if (Array.isArray(voice["avoids"]) && voice["avoids"].length) lines.push(`- Avoids: ${voice["avoids"].join(", ")}`);
    lines.push("");
  }
  if (ctx["primaryOffer"]) lines.push(`**Primary offer:** ${ctx["primaryOffer"]}\n`);
  if (ctx["pricingTier"]) lines.push(`**Pricing tier:** ${ctx["pricingTier"]}\n`);
  return lines.join("\n");
}

function businessToMarkdown(gymName: string, biz: Record<string, unknown>): string {
  const lines: string[] = [`# Business: ${gymName}`, ""];
  const tech = biz["techStack"] as Record<string, unknown> | undefined;
  if (tech) {
    lines.push("## Tech stack");
    if (tech["websiteBuilder"]) lines.push(`- Website builder: ${tech["websiteBuilder"]}`);
    if (tech["gymSoftware"]) lines.push(`- Gym software: ${tech["gymSoftware"]}`);
    if (tech["bookingMethod"]) lines.push(`- Booking: ${tech["bookingMethod"]}`);
    lines.push("");
  }
  const mkt = biz["marketingMaturity"] as Record<string, unknown> | undefined;
  if (mkt) {
    lines.push("## Marketing");
    if (Array.isArray(mkt["socialPlatforms"]) && mkt["socialPlatforms"].length) lines.push(`- Social: ${mkt["socialPlatforms"].join(", ")}`);
    if (mkt["runsPaidAds"]) lines.push(`- Runs paid ads: ${mkt["runsPaidAds"]}`);
    if (mkt["hasEmailList"]) lines.push(`- Email list: ${mkt["hasEmailList"]}`);
    lines.push("");
  }
  if (biz["assessment"]) lines.push(`**Assessment:** ${biz["assessment"]}\n`);
  return lines.join("\n");
}

export async function runLearn(opts: RunLearnOptions): Promise<RunLearnResult> {
  const logger = opts.logger ?? consoleLogger;
  const store = resolveDocStore(opts);
  logger.info(`[learn] Writing docs to ${store.uri()}`);

  // --- Step 1: normalize + fetch homepage
  const baseUrl = await normalizeBaseUrl(opts.url, opts.normalizeFetch ?? ((u, i) => fetch(u, i)));
  const home = await opts.fetcher.fetch(baseUrl);
  const homeHtml = home.html;
  const captureFonts = opts.captureFonts ?? captureFontsWithPlaywright;
  const homeFonts = home.fonts ?? await captureFonts(baseUrl);

  // --- Step 2: GMB / Places lookup (best-effort)
  const placesQuery = `${opts.gymName} ${opts.city} ${opts.state} ${opts.country}`.trim();
  let placesRaw: unknown | null = null;
  try { placesRaw = await opts.places.searchText(placesQuery); }
  catch (e) { logger.warn(`[learn] Places lookup failed: ${(e as Error).message}`); }
  const identity = placesToIdentity(placesRaw, {
    gymName: opts.gymName, city: opts.city, state: opts.state, country: opts.country, websiteUrl: baseUrl,
  });
  if (!identity.found) logger.warn(`[learn] No Places match — using crawl-only identity`);

  // --- Step 3: fetch homepage + up to keyPageLimit nav pages for business context
  // No per-page classification, no image downloads — text content only.
  const keyPageLimit = opts.keyPageLimit ?? 4;
  const navUrls = extractNavLinks(homeHtml, baseUrl)
    .filter((u) => u !== baseUrl)
    .slice(0, keyPageLimit);

  const homeDoc = extractPageDocument({ html: homeHtml, url: baseUrl, slug: "home", baseUrl, fetchMethod: home.fetchMethod, llmBudget: "full" });
  const additionalDocs: PageDocument[] = [];
  await mapWithConcurrency(navUrls, opts.concurrency, async (url) => {
    try {
      const fetched = await opts.fetcher.fetch(url);
      const doc = extractPageDocument({ html: fetched.html, url, slug: slugFor(url, baseUrl), baseUrl, fetchMethod: fetched.fetchMethod, llmBudget: "full" });
      additionalDocs.push(doc);
      logger.verbose(`[learn] fetched ${url}`);
    } catch (e) {
      logger.warn(`[learn] skipping ${url}: ${(e as Error).message}`);
    }
  });
  const pageDocs = [homeDoc, ...additionalDocs];

  // --- Step 4: brand signals (homepage only)
  const homepageSocialLinks = extractSocialLinks(homeHtml);
  const brand = BrandCrawl.parse({
    colors: extractColors(homeHtml),
    fonts: { ...extractFonts(homeHtml, homeFonts ?? undefined) },
    logo: extractLogo(homeHtml, baseUrl),
    socialLinks: homepageSocialLinks,
    software: fingerprintSoftware(homeHtml),
    analytics: detectAnalytics(homeHtml),
    fontFiles: [],
  });

  // --- Step 5: social scraping — enriches homepage doc with bio + recent posts
  // so LLMs see tone/voice signals from Instagram/Facebook even without subpage crawl.
  const socialScraper = opts.socialScraper ?? createRealSocialScraper();
  const scrapedProfiles = await scrapeSocialProfiles(homepageSocialLinks, socialScraper);
  enrichHomepageWithSocial(pageDocs, scrapedProfiles);
  if (scrapedProfiles.length > 0) {
    logger.info(`[learn] Scraped ${scrapedProfiles.length} social profile(s): ${scrapedProfiles.map((p) => p.platform).join(", ")}`);
  }

  // --- Step 6: GMB photos only (no page asset downloads)
  let gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[] = [];
  const assetsDir = await mkdtemp(path.join(os.tmpdir(), "milo-assets-"));
  try {
    gmbAssets = await downloadGmbPhotos(identity, assetsDir, opts.places.getPhotoUri.bind(opts.places), opts.downloadOne, opts.gmbPhotoMaxWidthPx, logger);
    for (const f of await readdir(assetsDir)) {
      await store.putFile(`assets/${f}`, path.join(assetsDir, f));
    }
  } finally {
    await rm(assetsDir, { recursive: true, force: true });
  }
  logger.info(`[learn] Downloaded ${gmbAssets.length} GMB photo(s)`);

  // --- Step 7: business intel LLM calls
  const budgets = new Map(pageDocs.map((p) => [p.slug, "full" as const]));
  const tBiz = Date.now();
  const business = await classifyBusiness({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, brand, identity, gmbAssets });
  logger.verbose(`[learn] classifyBusiness (${Date.now() - tBiz}ms)`);
  const integrations = buildIntegrations(brand);
  const tCtx = Date.now();
  const context = await analyzeContext({ chat: opts.chat, model: opts.capableModel, pages: pageDocs, budgets, identity, brand, gmbAssets });
  logger.verbose(`[learn] analyzeContext (${Date.now() - tCtx}ms)`);

  // --- Step 8: write docs
  await store.putJson("identity.json", identity);
  await store.putJson("brand.json", brand);
  await store.putJson("business.json", business);
  await store.putJson("context.json", context);
  await store.putJson("integrations.json", integrations);
  await store.putJson("gmb-assets.json", { downloadedAt: opts.discoveredAt, count: gmbAssets.length, assets: gmbAssets });
  await store.putText("context.md", contextToMarkdown(opts.gymName, context));
  await store.putText("business.md", businessToMarkdown(opts.gymName, business));

  logger.info(`[learn] Done — ${pageDocs.length} page(s) of context, GMB data, brand + voice docs at ${store.uri()}`);

  return { context, business, identity, brand, gmbAssets, integrations, docsUri: store.uri() };
}

/** Legacy full-crawl pipeline: crawls all pages, classifies them, then generates gym.json.
 * Prefer milo learn + milo clone for new workflows. */
export async function runIntake(opts: RunIntakeOptions): Promise<void> {
  const rules = opts.rules ?? loadCrawlRules();
  const logger = opts.logger ?? consoleLogger;
  const docs = resolveDocStore(opts);

  let identity: IdentityCrawl;
  let brand: BrandCrawl;
  let pageDocs: PageDocument[];
  let inventory: PagesJson;
  let gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[] = [];

  if (opts.skipCrawl) {
    const pagesJson = await docs.getJson("crawl/pages.json");
    if (!pagesJson) throw new Error(`No crawl bundle found at ${docs.uri()}/crawl. Run without --skip-crawl first.`);
    inventory = PagesJson.parse(pagesJson);
    identity = IdentityCrawl.parse(await docs.getJson("crawl/identity.json"));
    brand = BrandCrawl.parse(await docs.getJson("crawl/brand.json"));
    pageDocs = await Promise.all(inventory.pages.map(async (p) => PageDocument.parse(await docs.getJson(`crawl/pages/${p.slug}.json`))));
    try {
      const gmbAssetsDoc = (await docs.getJson("crawl/gmb-assets.json")) as { assets?: typeof gmbAssets } | null;
      gmbAssets = gmbAssetsDoc?.assets ?? [];
    } catch { /* gmb-assets.json may not exist in older crawl bundles */ }
  } else {
    const baseUrl = await normalizeBaseUrl(opts.url, opts.normalizeFetch ?? ((u, i) => fetch(u, i)));
    const home = await opts.fetcher.fetch(baseUrl);
    const homeHtml = home.html;
    const captureFonts = opts.captureFonts ?? captureFontsWithPlaywright;
    const homeFonts = home.fonts ?? await captureFonts(baseUrl);

    const placesQuery = `${opts.gymName} ${opts.city} ${opts.state} ${opts.country}`.trim();
    let placesRaw: unknown | null = null;
    try { placesRaw = await opts.places.searchText(placesQuery); }
    catch (e) { logger.warn(`[intake] Places lookup failed: ${(e as Error).message}`); }
    identity = placesToIdentity(placesRaw, { gymName: opts.gymName, city: opts.city, state: opts.state, country: opts.country, websiteUrl: baseUrl });
    if (!identity.found) logger.warn(`[intake] No Places match — using crawl-only identity`);

    let sitemapUrls: string[] = [];
    try { sitemapUrls = parseSitemap((await opts.fetcher.fetch(new URL("/sitemap.xml", baseUrl).href)).html); } catch { /* no sitemap */ }
    const navUrls = extractNavLinks(homeHtml, baseUrl);
    inventory = buildInventory({ baseUrl, sitemapUrls, navUrls, maxPages: opts.maxPages, discoveredAt: opts.discoveredAt, includeUgc: opts.includeUgc }, rules);

    const budgetOf = new Map(inventory.pages.map((p) => [p.url, p.llmBudget] as const));
    const sourceOf = new Map(inventory.pages.map((p) => [p.url, p.source] as const));
    const queued = new Set<string>(inventory.pages.map((p) => p.url));
    let queue = inventory.pages.map((p) => p.url);
    const crawledSlugs = new Map<string, string>();
    const pageLinks = new Map<string, string[]>();
    const rawDocs: PageDocument[] = [];

    while (queue.length > 0 && crawledSlugs.size < opts.maxPages) {
      const batch = queue.splice(0, opts.concurrency);
      const fetched = await mapWithConcurrency(batch, opts.concurrency, async (url): Promise<PageDocument | null> => {
        try {
          const f = url === baseUrl ? home : await opts.fetcher.fetch(url);
          const doc = extractPageDocument({ html: f.html, url, slug: slugFor(url, baseUrl), baseUrl, fetchMethod: f.fetchMethod, llmBudget: budgetOf.get(url) ?? "truncated" });
          logger.verbose(`[intake] crawled ${url}`);
          return doc;
        } catch (e) { logger.warn(`[intake] skipping ${url}: ${(e as Error).message}`); return null; }
      });
      for (const doc of fetched) {
        if (!doc) continue;
        crawledSlugs.set(doc.url, doc.slug);
        pageLinks.set(doc.url, doc.links);
        rawDocs.push(doc);
      }
      const toAdd = nextToCrawl({ baseUrl, newLinks: fetched.flatMap((d) => d?.links ?? []), alreadyQueued: queued, remaining: opts.maxPages - (crawledSlugs.size + queue.length), includeUgc: opts.includeUgc }, rules);
      for (const u of toAdd) queued.add(u);
      queue.push(...toAdd);
    }

    const linkMap = buildLinkMap({ baseUrl, discoveredAt: opts.discoveredAt, crawledSlugs, pageLinks }, rules);
    inventory = PagesJson.parse({ ...inventory, pages: rawDocs.map((d) => ({ url: d.url, slug: d.slug, priority: priorityFor(d.url), source: sourceOf.get(d.url) ?? "crawl-discovered", llmBudget: budgetOf.get(d.url) ?? "truncated" })) });

    pageDocs = await mapWithConcurrency(rawDocs, opts.concurrency, async (doc) => {
      const classified = await classifyPage(doc, { chat: opts.chat, model: opts.fastModel });
      logger.verbose(`[intake] classified ${doc.slug}`);
      return classified;
    });

    const homepageSocialLinks = extractSocialLinks(homeHtml);
    brand = BrandCrawl.parse({ colors: extractColors(homeHtml), fonts: { ...extractFonts(homeHtml, homeFonts ?? undefined) }, logo: extractLogo(homeHtml, baseUrl), socialLinks: homepageSocialLinks, software: fingerprintSoftware(homeHtml), analytics: detectAnalytics(homeHtml), fontFiles: [] });

    const socialScraper = opts.socialScraper ?? createRealSocialScraper();
    const scrapedProfiles = await scrapeSocialProfiles(homepageSocialLinks, socialScraper);
    enrichHomepageWithSocial(pageDocs, scrapedProfiles);

    const assetsDir = await mkdtemp(path.join(os.tmpdir(), "milo-assets-"));
    try {
      gmbAssets = await downloadGmbPhotos(identity, assetsDir, opts.places.getPhotoUri.bind(opts.places), opts.downloadOne, opts.gmbPhotoMaxWidthPx, logger);
      const assetMap = await downloadPageAssets(pageDocs, assetsDir, opts.downloadOne, logger);
      attachLocalAssetPaths(pageDocs, assetMap);
      for (const f of await readdir(assetsDir)) await docs.putFile(`assets/${f}`, path.join(assetsDir, f));
    } finally { await rm(assetsDir, { recursive: true, force: true }); }

    await docs.putJson("crawl/identity.json", identity);
    await docs.putJson("crawl/brand.json", brand);
    await docs.putJson("crawl/pages.json", inventory);
    await docs.putJson("crawl/links.json", linkMap);
    await docs.putJson("crawl/gmb-assets.json", { downloadedAt: opts.discoveredAt, count: gmbAssets.length, assets: gmbAssets });
    for (const doc of pageDocs) await docs.putJson(`crawl/pages/${doc.slug}.json`, doc);
  }

  const budgets = new Map(inventory.pages.map((p) => [p.slug, p.llmBudget] as const));
  const business = await classifyBusiness({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, brand, identity, gmbAssets });
  const integrations = buildIntegrations(brand);
  const context = await analyzeContext({ chat: opts.chat, model: opts.capableModel, pages: pageDocs, budgets, identity, brand, gmbAssets });
  const placeholderArchetypes = missingArchetypes(pageDocs);

  await docs.putJson("context.json", context);
  await docs.putJson("business.json", business);
  await docs.putJson("integrations.json", integrations);
  await docs.putText("context.md", contextToMarkdown(opts.gymName, context));
  await docs.putText("business.md", businessToMarkdown(opts.gymName, business));

  const { gym } = await generateSite({ chat: opts.chat, model: opts.capableModel, pages: pageDocs, budgets, identity, brand, context, business, placeholderArchetypes, gmbAssets });
  await docs.putJson("gym.json", gym);
  logger.info(`[intake] Wrote gym.json to ${docs.uri()}`);
}
