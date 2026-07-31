import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
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
  outDir: string;
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
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
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
): Promise<Record<string, string>> {
  const uniqueUrls = [...new Set(pages.flatMap((p) => p.images.map((i) => i.src)))];
  const results = await mapWithConcurrency(uniqueUrls, 5, async (url) => {
    const local = await downloadOne(url, assetsDir);
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

export async function runIntake(opts: RunIntakeOptions): Promise<void> {
  const rules = opts.rules ?? loadCrawlRules();
  const crawlDir = path.join(opts.outDir, "crawl");
  const pagesDir = path.join(crawlDir, "pages");

  let identity: IdentityCrawl;
  let brand: BrandCrawl;
  let pageDocs: PageDocument[];
  let inventory: PagesJson;
  let gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[] = [];

  if (opts.skipCrawl) {
    if (!(await exists(path.join(crawlDir, "pages.json")))) {
      throw new Error(`No crawl bundle found at ${crawlDir}. Run without --skip-crawl first.`);
    }
    inventory = PagesJson.parse(JSON.parse(await readFile(path.join(crawlDir, "pages.json"), "utf8")));
    identity = IdentityCrawl.parse(JSON.parse(await readFile(path.join(crawlDir, "identity.json"), "utf8")));
    brand = BrandCrawl.parse(JSON.parse(await readFile(path.join(crawlDir, "brand.json"), "utf8")));
    pageDocs = await Promise.all(
      inventory.pages.map(async (p) =>
        PageDocument.parse(JSON.parse(await readFile(path.join(pagesDir, `${p.slug}.json`), "utf8")))),
    );
    // Re-hydrate GMB assets so prompts still get photo context on re-runs.
    try {
      const gmbAssetsDoc = JSON.parse(await readFile(path.join(crawlDir, "gmb-assets.json"), "utf8"));
      gmbAssets = gmbAssetsDoc.assets ?? [];
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
    catch (e) { console.warn(`[intake] Places lookup failed: ${(e as Error).message}`); }
    identity = placesToIdentity(placesRaw, {
      gymName: opts.gymName,
      city: opts.city,
      state: opts.state,
      country: opts.country,
      websiteUrl: baseUrl,
    });
    if (!identity.found) console.warn(`[intake] No Places match — using crawl-only identity`);

    // --- Step 2: discovery
    let sitemapUrls: string[] = [];
    try {
      const sm = await opts.fetcher.fetch(new URL("/sitemap.xml", baseUrl).href);
      sitemapUrls = parseSitemap(sm.html);
    } catch { /* no sitemap */ }
    const navUrls = extractNavLinks(homeHtml, baseUrl);
    inventory = buildInventory({ baseUrl, sitemapUrls, navUrls, maxPages: opts.maxPages, discoveredAt: opts.discoveredAt, includeUgc: opts.includeUgc }, rules);
    if (inventory.capped > 0) console.warn(`Capped at ${opts.maxPages} pages (${inventory.capped} additional pages were skipped)`);

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
          return extractPageDocument({ html: fetched.html, url, slug, baseUrl, fetchMethod: fetched.fetchMethod, llmBudget });
        } catch (e) {
          // Page fetch fails → skip page, log warning, continue. A single bad page
          // (HTTP error, network failure) must never crash the whole run.
          console.warn(`[intake] skipping ${url}: ${(e as Error).message}`);
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
    pageDocs = await mapWithConcurrency(rawDocs, opts.concurrency, (doc) => classifyPage(doc, { chat: opts.chat, model: opts.fastModel }));

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
      console.log(`[intake] Scraped ${scrapedProfiles.length} social profile(s): ${scrapedProfiles.map((p) => p.platform).join(", ")}`);
    }

    // --- Step 4b: download GMB photos + page assets so generated sites don't hot-link source CDNs
    const assetsDir = path.join(opts.outDir, "assets");
    gmbAssets = await downloadGmbPhotos(identity, assetsDir, opts.places.getPhotoUri.bind(opts.places), opts.downloadOne, opts.gmbPhotoMaxWidthPx);
    const assetMap = await downloadPageAssets(pageDocs, assetsDir, opts.downloadOne);
    attachLocalAssetPaths(pageDocs, assetMap);

    // --- persist crawl bundle
    const gmbAssetsDoc = {
      downloadedAt: opts.discoveredAt,
      count: gmbAssets.length,
      assets: gmbAssets,
    };
    await writeJson(path.join(crawlDir, "identity.json"), identity);
    await writeJson(path.join(crawlDir, "gmb-assets.json"), gmbAssetsDoc);
    await writeJson(path.join(crawlDir, "brand.json"), brand);
    await writeJson(path.join(crawlDir, "pages.json"), inventory);
    await writeJson(path.join(crawlDir, "links.json"), linkMap);
    console.log(`[intake] Link map: ${linkMap.nodes.length} internal URLs (${linkMap.nodes.filter((n) => n.crawled).length} crawled, ${linkMap.nodes.filter((n) => !n.crawled).length} mapped-only)`);
    console.log(`[intake] Downloaded ${gmbAssets.length} GMB photos + ${Object.keys(assetMap).length} page assets to ${assetsDir}`);
    for (const doc of pageDocs) await writeJson(path.join(pagesDir, `${doc.slug}.json`), doc);
  }

  // --- Step 5: project docs into site content
  const budgets = new Map(inventory.pages.map((p) => [p.slug, p.llmBudget] as const));
  const business = await classifyBusiness({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, brand, identity, gmbAssets });
  const integrations = buildIntegrations(brand);
  const context = await analyzeContext({ chat: opts.chat, model: opts.capableModel, pages: pageDocs, budgets, identity, brand, gmbAssets });
  const placeholderArchetypes = missingArchetypes(pageDocs);
  if (placeholderArchetypes.length > 0) {
    console.warn(`[intake] Thin input — creating placeholder pages for: ${placeholderArchetypes.join(", ")}`);
  }
  const { gym } = await generateSite({
    chat: opts.chat,
    model: opts.capableModel,
    pages: pageDocs,
    budgets,
    identity,
    brand,
    context,
    business,
    placeholderArchetypes,
  });

  // --- write outputs
  // gym was already deep-validated by generateSite() against GymDocumentsStrict;
  // no need to re-parse here.
  await writeJson(path.join(opts.outDir, "gym.json"), gym);
  await writeJson(path.join(opts.outDir, "context.json"), context);
  await writeJson(path.join(opts.outDir, "business.json"), business);
  await writeJson(path.join(opts.outDir, "integrations.json"), integrations);

  console.log(`[intake] Wrote gym.json + context.json + business.json + integrations.json to ${opts.outDir}`);
}
