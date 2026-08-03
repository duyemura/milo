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
  pageDocs: PageDocument[];
  gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[];
  placeholderArchetypes: string[];
  budgets: Map<string, "full" | "truncated">;
  integrations: Record<string, unknown>;
  /** URI of the docs root everything was written to, e.g. file:///Users/x/.milo/gyms/<slug>/docs */
  docsUri: string;
}

export interface RunIntakeOptions {
  url: string;
  /** Gym name as supplied by operator. Used for GMB query and as identity fallback. */
  gymName: string;
  /** City as supplied by operator. Used for GMB query and address enrichment. */
  city: string;
  /** State/region as supplied by operator. Used for GMB query and address enrichment. */
  state: string;
  /** Country as supplied by operator. Defaults to US. */
  country: string;
  /** When set, docs are written directly into this dir (LocalFsAdapter, no key prefix) — preserves pre-storage behavior. */
  outDir?: string;
  maxPages: number;
  includeUgc: boolean;
  concurrency: number;
  places: PlacesClient;
  fetcher: PageFetcher;
  chat: ChatFn;
  capableModel: string;
  fastModel: string;
  skipCrawl?: boolean;
  /** Injectable for URL normalization (real: global fetch). */
  normalizeFetch?: FetchLike;
  /** Injectable timestamp (scripts can't use Date.now in some contexts). */
  discoveredAt: string;
  /** Injectable font capture for tests. Defaults to Playwright. */
  captureFonts?: (url: string) => Promise<{ display: string; body: string } | null>;
  /** Injectable asset downloader for tests. Defaults to downloadAsset. */
  downloadOne?: (url: string, assetsDir: string, preferredName?: string) => Promise<string | null>;
  /** Max width for downloaded GMB photos. */
  gmbPhotoMaxWidthPx?: number;
  /** Path to a custom crawl-priority rules file. Defaults to bundled rules. */
  rules?: CompiledCrawlRules;
  /** Injectable social scraper. Defaults to createRealSocialScraper. */
  socialScraper?: SocialScraper;
  /** Injectable storage backend. Default: outDir mode → LocalFsAdapter(outDir); otherwise getStorage(). */
  storage?: StorageAdapter;
  /** Docs key slug. Default: slugFromUrl(url). Ignored in outDir mode. */
  slug?: string;
  /** Injectable logger. Default: consoleLogger (verbose suppressed). */
  logger?: MiloLogger;
}

export type RunLearnOptions = RunIntakeOptions;

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
  const rules = opts.rules ?? loadCrawlRules();
  const logger = opts.logger ?? consoleLogger;
  const docs = resolveDocStore(opts);
  logger.info(`[learn] Writing docs to ${docs.uri()}`);

  let identity: IdentityCrawl;
  let brand: BrandCrawl;
  let pageDocs: PageDocument[];
  let inventory: PagesJson;
  let gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[] = [];

  if (opts.skipCrawl) {
    const pagesJson = await docs.getJson("crawl/pages.json");
    if (!pagesJson) {
      throw new Error(`No crawl bundle found at ${docs.uri()}/crawl. Run without --skip-crawl first.`);
    }
    inventory = PagesJson.parse(pagesJson);
    identity = IdentityCrawl.parse(await docs.getJson("crawl/identity.json"));
    brand = BrandCrawl.parse(await docs.getJson("crawl/brand.json"));
    pageDocs = await Promise.all(
      inventory.pages.map(async (p) =>
        PageDocument.parse(await docs.getJson(`crawl/pages/${p.slug}.json`))),
    );
    // Re-hydrate GMB assets so prompts still get photo context on re-runs.
    try {
      const gmbAssetsDoc = (await docs.getJson("crawl/gmb-assets.json")) as { assets?: typeof gmbAssets } | null;
      gmbAssets = gmbAssetsDoc?.assets ?? [];
    } catch { /* gmb-assets.json may not exist in older crawl bundles */ }
  } else {
    // --- Step 1: normalize base + fetch homepage
    const baseUrl = await normalizeBaseUrl(opts.url, opts.normalizeFetch ?? ((u, i) => fetch(u, i)));
    // A dead homepage is fatal — let this throw.
    const home = await opts.fetcher.fetch(baseUrl);
    const homeHtml = home.html;

    // Capture computed fonts from the rendered homepage. Static fetches don't carry
    // font information, but real brand signals almost always live in computed styles
    // (external CSS, @font-face) rather than inline CSS regex targets.
    const captureFonts = opts.captureFonts ?? captureFontsWithPlaywright;
    const homeFonts = home.fonts ?? await captureFonts(baseUrl);

    // --- Step 1b: Places identity (best-effort)
    // Operator-supplied name + city/state/country gives a much better GMB query than
    // guessing from the homepage.
    const placesQuery = `${opts.gymName} ${opts.city} ${opts.state} ${opts.country}`.trim();
    let placesRaw: unknown | null = null;
    try { placesRaw = await opts.places.searchText(placesQuery); }
    catch (e) { logger.warn(`[intake] Places lookup failed: ${(e as Error).message}`); }
    identity = placesToIdentity(placesRaw, {
      gymName: opts.gymName,
      city: opts.city,
      state: opts.state,
      country: opts.country,
      websiteUrl: baseUrl,
    });
    if (!identity.found) logger.warn(`[intake] No Places match — using crawl-only identity`);

    // --- Step 2: discovery
    let sitemapUrls: string[] = [];
    try {
      const sm = await opts.fetcher.fetch(new URL("/sitemap.xml", baseUrl).href);
      sitemapUrls = parseSitemap(sm.html);
    } catch { /* no sitemap */ }
    const navUrls = extractNavLinks(homeHtml, baseUrl);
    inventory = buildInventory({ baseUrl, sitemapUrls, navUrls, maxPages: opts.maxPages, discoveredAt: opts.discoveredAt, includeUgc: opts.includeUgc }, rules);
    if (inventory.capped > 0) logger.warn(`Capped at ${opts.maxPages} pages (${inventory.capped} additional pages were skipped)`);

    // --- Step 3: crawl with queue expansion; record the FULL internal link graph.
    // Seed the queue from the inventory. As pages are crawled, every same-origin
    // link they contain (a) may be enqueued up to --max-pages, and (b) is recorded
    // in the link map regardless of the cap. Nothing internal is silently dropped.
    const budgetOf = new Map(inventory.pages.map((p) => [p.url, p.llmBudget] as const));
    const sourceOf = new Map(inventory.pages.map((p) => [p.url, p.source] as const));
    const queued = new Set<string>(inventory.pages.map((p) => p.url));
    let queue: string[] = inventory.pages.map((p) => p.url);
    const crawledSlugs = new Map<string, string>();      // url -> slug (crawled only)
    const pageLinks = new Map<string, string[]>();        // url -> same-origin links seen
    const rawDocs: PageDocument[] = [];

    while (queue.length > 0 && crawledSlugs.size < opts.maxPages) {
      const batch = queue.slice(0, opts.concurrency);
      queue = queue.slice(opts.concurrency);

      const docs = await mapWithConcurrency(batch, opts.concurrency, async (url): Promise<PageDocument | null> => {
        const isHome = url === baseUrl;
        try {
          const fetched = isHome ? home : await opts.fetcher.fetch(url);
          const slug = slugFor(url, baseUrl);
          // Pages found mid-crawl (beyond the priority seed) default to truncated budget.
          const llmBudget = budgetOf.get(url) ?? "truncated";
          const doc = extractPageDocument({ html: fetched.html, url, slug, baseUrl, fetchMethod: fetched.fetchMethod, llmBudget });
          logger.verbose(`[learn] crawled ${url} (via ${fetched.fetchMethod}, ${doc.images.length} images)`);
          return doc;
        } catch (e) {
          // Page fetch fails → skip page, log warning, continue. A single bad page
          // (HTTP error, network failure) must never crash the whole run.
          logger.warn(`[intake] skipping ${url}: ${(e as Error).message}`);
          return null;
        }
      });

      for (const doc of docs) {
        if (!doc) continue;
        crawledSlugs.set(doc.url, doc.slug);
        pageLinks.set(doc.url, doc.links);
        rawDocs.push(doc);
      }

      // Expand: enqueue newly-seen non-UGC same-origin links up to remaining budget.
      const newLinks = docs.flatMap((d) => d?.links ?? []);
      const remaining = opts.maxPages - (crawledSlugs.size + queue.length);
      const toAdd = nextToCrawl({ baseUrl, newLinks, alreadyQueued: queued, remaining, includeUgc: opts.includeUgc }, rules);
      for (const url of toAdd) queued.add(url);
      queue.push(...toAdd);
    }

    // Full internal link map — includes URLs we saw but never crawled.
    const linkMap = buildLinkMap({ baseUrl, discoveredAt: opts.discoveredAt, crawledSlugs, pageLinks }, rules);

    // Rebuild the inventory so pages.json reflects everything actually crawled.
    inventory = PagesJson.parse({
      ...inventory,
      pages: rawDocs.map((d) => ({
        url: d.url, slug: d.slug, priority: priorityFor(d.url),
        source: sourceOf.get(d.url) ?? "crawl-discovered",   // preserve nav/sitemap provenance
        llmBudget: budgetOf.get(d.url) ?? "truncated",
      })),
    });

    // --- Step 3b: per-page LLM classification (fast model)
    pageDocs = await mapWithConcurrency(rawDocs, opts.concurrency, async (doc) => {
      const t0 = Date.now();
      const classified = await classifyPage(doc, { chat: opts.chat, model: opts.fastModel });
      logger.verbose(`[learn] classified ${doc.slug} (${Date.now() - t0}ms)`);
      return classified;
    });

    // --- Step 4: brand extraction (homepage)
    const homepageSocialLinks = extractSocialLinks(homeHtml);
    brand = BrandCrawl.parse({
      colors: extractColors(homeHtml),
      fonts: { ...extractFonts(homeHtml, homeFonts ?? undefined) },
      logo: extractLogo(homeHtml, baseUrl),
      socialLinks: homepageSocialLinks,
      software: fingerprintSoftware(homeHtml),
      analytics: detectAnalytics(homeHtml),
      fontFiles: [],
    });

    // --- Step 4a: social scrape (best-effort) — homepage body gets enriched so
    // context/business LLMs see Instagram bio + recent captions even when we
    // can't crawl subpages.
    const socialScraper = opts.socialScraper ?? createRealSocialScraper();
    const scrapedProfiles = await scrapeSocialProfiles(homepageSocialLinks, socialScraper);
    enrichHomepageWithSocial(pageDocs, scrapedProfiles);
    if (scrapedProfiles.length > 0) {
      logger.info(`[intake] Scraped ${scrapedProfiles.length} social profile(s): ${scrapedProfiles.map((p) => p.platform).join(", ")}`);
    }

    // --- Step 4b: download GMB photos + page assets so generated sites don't hot-link source CDNs
    // Downloads stage in a tmp dir, then upload through the storage seam — one code
    // path for local disk and S3. pageDocs keep "/assets/<name>" web paths either way.
    const assetsDir = await mkdtemp(path.join(os.tmpdir(), "milo-assets-"));
    let assetMap: Record<string, string> = {};
    try {
      gmbAssets = await downloadGmbPhotos(identity, assetsDir, opts.places.getPhotoUri.bind(opts.places), opts.downloadOne, opts.gmbPhotoMaxWidthPx, logger);
      assetMap = await downloadPageAssets(pageDocs, assetsDir, opts.downloadOne, logger);
      attachLocalAssetPaths(pageDocs, assetMap);

      for (const f of await readdir(assetsDir)) {
        await docs.putFile(`assets/${f}`, path.join(assetsDir, f));
      }
    } finally {
      // Always clean up staging — a failed download or a loud S3 put must not orphan it.
      await rm(assetsDir, { recursive: true, force: true });
    }

    // --- persist crawl bundle
    const gmbAssetsDoc = {
      downloadedAt: opts.discoveredAt,
      count: gmbAssets.length,
      assets: gmbAssets,
    };
    await docs.putJson("crawl/identity.json", identity);
    await docs.putJson("crawl/gmb-assets.json", gmbAssetsDoc);
    await docs.putJson("crawl/links.json", linkMap);
    // Canonical top-level copies (Phase 2 readers). crawl/ duplicates kept for the
    // deprecated generate path — apps/cli/src/generate.ts reads crawl/brand.json + crawl/pages.json.
    await docs.putJson("brand.json", brand);
    await docs.putJson("pages.json", inventory);
    await docs.putJson("crawl/brand.json", brand);
    await docs.putJson("crawl/pages.json", inventory);
    logger.info(`[intake] Link map: ${linkMap.nodes.length} internal URLs (${linkMap.nodes.filter((n) => n.crawled).length} crawled, ${linkMap.nodes.filter((n) => !n.crawled).length} mapped-only)`);
    logger.info(`[intake] Downloaded ${gmbAssets.length} GMB photos + ${Object.keys(assetMap).length} page assets`);
    for (const doc of pageDocs) await docs.putJson(`crawl/pages/${doc.slug}.json`, doc);
  }

  // --- Step 5: project docs into site content
  const budgets = new Map(inventory.pages.map((p) => [p.slug, p.llmBudget] as const));
  const tBiz = Date.now();
  const business = await classifyBusiness({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, brand, identity, gmbAssets });
  logger.verbose(`[learn] classifyBusiness model=${opts.fastModel} (${Date.now() - tBiz}ms)`);
  const integrations = buildIntegrations(brand);
  const tCtx = Date.now();
  const context = await analyzeContext({ chat: opts.chat, model: opts.capableModel, pages: pageDocs, budgets, identity, brand, gmbAssets });
  logger.verbose(`[learn] analyzeContext model=${opts.capableModel} (${Date.now() - tCtx}ms)`);
  const placeholderArchetypes = missingArchetypes(pageDocs);
  if (placeholderArchetypes.length > 0) {
    logger.warn(`[intake] Thin input — creating placeholder pages for: ${placeholderArchetypes.join(", ")}`);
  }

  // Write docs in both JSON (template compat) and Markdown (new format)
  await docs.putJson("context.json", context);
  await docs.putJson("business.json", business);
  await docs.putJson("integrations.json", integrations);
  await docs.putText("context.md", contextToMarkdown(opts.gymName, context));
  await docs.putText("business.md", businessToMarkdown(opts.gymName, business));

  logger.info(`[learn] Wrote docs to ${docs.uri()}`);

  return { context, business, identity, brand, pageDocs, gmbAssets, placeholderArchetypes, budgets, integrations, docsUri: docs.uri() };
}

/** Backward-compat wrapper: runs runLearn then generates gym.json. */
export async function runIntake(opts: RunLearnOptions): Promise<void> {
  const result = await runLearn(opts);
  const { gym } = await generateSite({
    chat: opts.chat,
    model: opts.capableModel,
    pages: result.pageDocs,
    budgets: result.budgets,
    identity: result.identity,
    brand: result.brand,
    context: result.context,
    business: result.business,
    placeholderArchetypes: result.placeholderArchetypes,
    gmbAssets: result.gmbAssets,
  });
  const docs = resolveDocStore(opts);
  await docs.putJson("gym.json", gym);
  const logger = opts.logger ?? consoleLogger;
  logger.info(`[intake] Wrote gym.json to ${docs.uri()}`);
}
