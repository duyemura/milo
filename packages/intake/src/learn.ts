import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { type StorageAdapter, type Asset, ingestFromUrl, ingestFromBuffer, loadLibrary, findBySourceRef, slugFromUrl } from "@milo/storage";
import { resolveDocStore } from "./doc-store.ts";
import { consoleLogger, type MiloLogger } from "./logger.ts";
import { PageDocument, BrandCrawl, IdentityCrawl } from "@milo/schema";
import type { PlacesClient } from "./places.ts";
import { placesToIdentity } from "./places.ts";
import type { PageFetcher } from "./crawl.ts";
import { extractPageDocument, captureFontsWithPlaywright } from "./crawl.ts";
import { normalizeBaseUrl, extractNavLinks, slugFor } from "./discover.ts";
import type { FetchLike } from "./discover.ts";
import { extractColors, extractFonts, extractLogo, extractSocialLinks, fingerprintSoftware, detectAnalytics } from "./brand.ts";
import { classifyBusiness, buildIntegrations } from "./classify.ts";
import { analyzeContext } from "./context.ts";
import type { ChatFn } from "@milo/llm";
import { createRealSocialScraper, type SocialScraper, type SocialProfile } from "./social.ts";

export interface RunLearnResult {
  context: Record<string, unknown>;
  business: Record<string, unknown>;
  identity: IdentityCrawl;
  brand: BrandCrawl;
  gmbAssets: Asset[];
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
  /** Max pixel width for downloaded GMB photos (default: 1600). */
  gmbPhotoMaxWidthPx?: number;
  /** Max post images downloaded per social profile (default: 3). */
  maxSocialPostImages?: number;
  socialScraper?: SocialScraper;
  storage?: StorageAdapter;
  slug?: string;
  /**
   * Local directory for the asset library (library.json + library/ images).
   * Defaults to outDir if set, otherwise ~/.milo/gyms/<slug>/
   */
  businessDir?: string;
  /** Inject an alternative fetch for testing image downloads. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  logger?: MiloLogger;
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

/**
 * Ingest GMB photos into the local asset library. Sequential to avoid library.json
 * read-modify-write races. Pre-download dedup via sourceRef (GMB resource name) skips
 * both the API call and the download for already-catalogued photos.
 */
async function ingestGmbPhotos(
  identity: IdentityCrawl,
  businessDir: string,
  slug: string,
  getPhotoUri: (photoName: string, maxWidthPx?: number) => Promise<string | null>,
  maxWidthPx = 1600,
  logger?: MiloLogger,
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<Asset[]> {
  if (!identity.photos?.length) return [];
  const candidates = identity.photos
    .filter((p) => p.name)
    .slice(0, 8)
    .sort((a, b) => (b.widthPx ?? 0) - (a.widthPx ?? 0));

  const assets: Asset[] = [];
  for (const photo of candidates) {
    const sourceRef = photo.name;
    const existing = findBySourceRef(loadLibrary(businessDir, "biz_unknown"), sourceRef);
    if (existing) {
      logger?.verbose(`[learn] gmb photo cached: ${photo.name}`);
      assets.push(existing);
      continue;
    }
    const uri = await getPhotoUri(photo.name, maxWidthPx);
    if (!uri) continue;
    const attribution = photo.authorAttributions?.map((a) => a.displayName).filter(Boolean).join(", ");
    try {
      const { asset } = await ingestFromUrl(businessDir, uri, { source: "upload", sourceRef, siteOrigin: slug, ...(attribution ? { attribution } : {}), fetchFn });
      logger?.verbose(`[learn] gmb photo ingested: ${photo.name}`);
      assets.push(asset);
    } catch (e) {
      logger?.warn(`[learn] gmb photo failed (${photo.name}): ${(e as Error).message}`);
    }
  }
  return assets;
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

/**
 * Ingest social profile and post images into the local asset library. Sequential to
 * avoid library.json races. Content-hash dedup handles re-runs and position changes.
 */
async function ingestSocialImages(
  profiles: SocialProfile[],
  businessDir: string,
  slug: string,
  logger?: MiloLogger,
  maxPostImages = 3,
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<Asset[]> {
  const assets: Asset[] = [];
  for (const profile of profiles) {
    // Profile image: always URL-based
    if (profile.profileImage) {
      try {
        const { asset, cached } = await ingestFromUrl(businessDir, profile.profileImage, {
          source: "upload",
          siteOrigin: slug,
          altText: `${profile.platform} profile — @${profile.handle}`,
          fetchFn,
        });
        logger?.verbose(`[learn] social profile @${profile.handle} → ${cached ? "cached" : "ingested"} → ${asset.file}`);
        assets.push(asset);
      } catch (e) {
        logger?.verbose(`[learn] social profile @${profile.handle} failed: ${(e as Error).message}`);
      }
    }

    // Post images: use pre-fetched bytes when available (avoids second download + expired CDN tokens)
    if ((profile.capturedImages?.length ?? 0) > 0) {
      for (const { buffer, altText } of (profile.capturedImages ?? []).slice(0, maxPostImages)) {
        try {
          const { asset, cached } = ingestFromBuffer(businessDir, buffer, {
            source: "upload",
            siteOrigin: slug,
            altText: altText ?? `${profile.platform} post — @${profile.handle}`,
          });
          logger?.verbose(`[learn] social post @${profile.handle} → ${cached ? "cached" : "ingested"} (intercepted, ${buffer.length}B) → ${asset.file}`);
          assets.push(asset);
        } catch (e) {
          logger?.verbose(`[learn] social post @${profile.handle} failed: ${(e as Error).message}`);
        }
      }
    } else {
      // Fallback: download from postImages URLs
      for (const imgUrl of (profile.postImages ?? []).slice(0, maxPostImages)) {
        try {
          const { asset, cached } = await ingestFromUrl(businessDir, imgUrl, {
            source: "upload",
            siteOrigin: slug,
            altText: `${profile.platform} post — @${profile.handle}`,
            fetchFn,
          });
          logger?.verbose(`[learn] social post @${profile.handle} → ${cached ? "cached" : "ingested"} → ${asset.file}`);
          assets.push(asset);
        } catch (e) {
          logger?.verbose(`[learn] social post @${profile.handle} failed: ${(e as Error).message}`);
        }
      }
    }
  }
  return assets;
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

  // Steps 1 + 2 in parallel: URL normalization and GMB search are independent
  const placesQuery = `${opts.gymName} ${opts.city} ${opts.state} ${opts.country}`.trim();
  const [baseUrl, placesRaw] = await Promise.all([
    normalizeBaseUrl(opts.url, opts.normalizeFetch ?? ((u, i) => fetch(u, i))),
    opts.places.searchText(placesQuery).catch((e: Error) => {
      logger.warn(`[learn] Places lookup failed: ${e.message}`); return null;
    }),
  ]);
  const home = await opts.fetcher.fetch(baseUrl);
  const homeHtml = home.html;
  const captureFonts = opts.captureFonts ?? captureFontsWithPlaywright;
  const homeFonts = home.fonts ?? await captureFonts(baseUrl);
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

  const homeDoc = extractPageDocument({ html: homeHtml, url: baseUrl, slug: "index", baseUrl, fetchMethod: home.fetchMethod, llmBudget: "full" });
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

  // Steps 5 + 6: social scraping (parallel) then asset ingestion into local library
  const slug = opts.slug ?? slugFromUrl(opts.url);
  const businessDir = opts.businessDir ?? opts.outDir ?? path.join(os.homedir(), ".milo", "gyms", slug);
  const socialScraper = opts.socialScraper ?? createRealSocialScraper();
  const scrapedProfiles = await scrapeSocialProfiles(homepageSocialLinks, socialScraper);
  enrichHomepageWithSocial(pageDocs, scrapedProfiles);
  if (scrapedProfiles.length > 0) {
    logger.info(`[learn] Scraped ${scrapedProfiles.length} social profile(s): ${scrapedProfiles.map((p) => p.platform).join(", ")}`);
    for (const p of scrapedProfiles) {
      const imgSummary = (p.capturedImages?.length ?? 0) > 0
        ? `capturedImages=${p.capturedImages!.length}`
        : `postImages=${p.postImages?.length ?? 0}`;
      logger.verbose(`[learn] ${p.platform} @${p.handle}: profileImage=${p.profileImage ? "yes" : "no"}, ${imgSummary}`);
    }
  }

  const gmbAssets = await ingestGmbPhotos(
    identity, businessDir, slug,
    opts.places.getPhotoUri.bind(opts.places), opts.gmbPhotoMaxWidthPx, logger, opts.fetchFn,
  );
  logger.info(`[learn] Downloaded ${gmbAssets.length} GMB photo(s)`);

  const socialAssets = await ingestSocialImages(
    scrapedProfiles, businessDir, slug, logger, opts.maxSocialPostImages, opts.fetchFn,
  );
  if (socialAssets.length > 0) {
    logger.info(`[learn] Downloaded ${socialAssets.length} social image(s)`);
  }

  // --- Step 7: business intel — all three LLM calls in parallel on fastModel
  const budgets = new Map(pageDocs.map((p) => [p.slug, "full" as const]));
  const tLlm = Date.now();
  const [business, context] = await Promise.all([
    classifyBusiness({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, brand, identity, assets: gmbAssets }),
    analyzeContext({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, budgets, identity, brand, assets: gmbAssets }),
  ]);
  const integrations = buildIntegrations(brand);
  logger.verbose(`[learn] LLM calls (${Date.now() - tLlm}ms)`);

  // --- Step 8: write docs
  await store.putJson("identity.json", identity);
  // reviews.json: raw reviews separate from identity so they're easy to query/display later
  if (identity.reviews?.length) {
    await store.putJson("reviews.json", {
      fetchedAt: opts.discoveredAt,
      rating: identity.rating,
      reviewCount: identity.reviewCount,
      reviews: identity.reviews,
    });
  }
  await store.putJson("brand.json", brand);
  await store.putJson("business.json", business);
  await store.putJson("context.json", context);
  await store.putJson("integrations.json", integrations);
  await store.putJson("gmb-assets.json", { downloadedAt: opts.discoveredAt, count: gmbAssets.length, assets: gmbAssets.map((a) => ({ id: a.id, file: a.file, dimensions: a.dimensions, attribution: a.attribution, sourceRef: a.sourceRef })) });
  await store.putJson("social-assets.json", { downloadedAt: opts.discoveredAt, count: socialAssets.length, assets: socialAssets.map((a) => ({ id: a.id, file: a.file, dimensions: a.dimensions, altText: a.altText })) });
  await store.putText("context.md", contextToMarkdown(opts.gymName, context));
  await store.putText("business.md", businessToMarkdown(opts.gymName, business));

  // Mirror asset files to the storage backend (MinIO in production).
  // Assets are written locally first by the asset library; this step syncs
  // them to gyms/<slug>/images/ so they're visible in the object browser.
  const allAssets = [...gmbAssets, ...socialAssets];
  if (allAssets.length > 0) {
    let uploaded = 0;
    for (const asset of allAssets) {
      const localPath = path.join(businessDir, asset.file);
      if (!fs.existsSync(localPath)) {
        logger.warn(`[learn] asset file missing locally, skipping upload: ${localPath}`);
        continue;
      }
      // asset.file = "library/ast_uuid.jpg" → store under images/ast_uuid.jpg
      const filename = path.basename(asset.file);
      const remoteKey = `gyms/${slug}/images/${filename}`;
      await store.storage.put(remoteKey, fs.readFileSync(localPath));
      logger.verbose(`[learn] uploaded ${remoteKey}`);
      uploaded++;
    }
    if (uploaded > 0) logger.info(`[learn] Uploaded ${uploaded} asset(s) to gyms/${slug}/images/`);
  }

  logger.info(`[learn] Done — ${pageDocs.length} page(s) of context, GMB data, brand + voice docs at ${store.uri()}`);

  return { context, business, identity, brand, gmbAssets, integrations, docsUri: store.uri() };

}

