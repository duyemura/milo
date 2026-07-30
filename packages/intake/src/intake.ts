import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { PagesJson, PageDocument, BrandCrawl, IdentityCrawl } from "@milo/schema";
import type { PlacesClient } from "./places.ts";
import { placesToIdentity } from "./places.ts";
import type { PageFetcher } from "./crawl.ts";
import { extractPageDocument } from "./crawl.ts";
import { normalizeBaseUrl, parseSitemap, extractNavLinks, buildInventory, slugFor, priorityFor } from "./discover.ts";
import type { FetchLike } from "./discover.ts";
import { nextToCrawl, buildLinkMap } from "./crawl-graph.ts";
import { extractColors, extractFonts, extractLogo, extractSocialLinks, fingerprintSoftware, detectAnalytics } from "./brand.ts";
import { classifyPage, classifyBusiness, buildIntegrations } from "./classify.ts";
import { analyzeContext } from "./context.ts";
import { generateSite } from "@milo/generate";
import type { ChatFn } from "@milo/llm";

export interface RunIntakeOptions {
  url: string;
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

export async function runIntake(opts: RunIntakeOptions): Promise<void> {
  const crawlDir = path.join(opts.outDir, "crawl");
  const pagesDir = path.join(crawlDir, "pages");

  let identity: IdentityCrawl;
  let brand: BrandCrawl;
  let pageDocs: PageDocument[];
  let inventory: PagesJson;

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
  } else {
    // --- Step 1: normalize base + fetch homepage
    const baseUrl = await normalizeBaseUrl(opts.url, opts.normalizeFetch ?? ((u, i) => fetch(u, i)));
    // A dead homepage is fatal — let this throw.
    const home = await opts.fetcher.fetch(baseUrl);
    const homeHtml = home.html;

    // --- Step 1b: Places identity (best-effort)
    const gymName = homeHtml.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)/i)?.[1]
      ?? homeHtml.match(/<title>([^<]+)/i)?.[1]?.trim() ?? new URL(baseUrl).hostname;
    const city = ""; // best-effort; refine from address text later
    let placesRaw: unknown | null = null;
    try { placesRaw = await opts.places.searchText(`${gymName} ${city}`.trim()); }
    catch (e) { console.warn(`[intake] Places lookup failed: ${(e as Error).message}`); }
    identity = placesToIdentity(placesRaw);
    if (!identity.found) console.warn(`[intake] No Places match — using crawl-only identity`);

    // --- Step 2: discovery
    let sitemapUrls: string[] = [];
    try {
      const sm = await opts.fetcher.fetch(new URL("/sitemap.xml", baseUrl).href);
      sitemapUrls = parseSitemap(sm.html);
    } catch { /* no sitemap */ }
    const navUrls = extractNavLinks(homeHtml, baseUrl);
    inventory = buildInventory({ baseUrl, sitemapUrls, navUrls, maxPages: opts.maxPages, discoveredAt: opts.discoveredAt, includeUgc: opts.includeUgc });
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
      const toAdd = nextToCrawl({ baseUrl, newLinks, alreadyQueued: queued, remaining, includeUgc: opts.includeUgc });
      for (const url of toAdd) queued.add(url);
      queue.push(...toAdd);
    }

    // Full internal link map — includes URLs we saw but never crawled.
    const linkMap = buildLinkMap({ baseUrl, discoveredAt: opts.discoveredAt, crawledSlugs, pageLinks });

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
    brand = BrandCrawl.parse({
      colors: extractColors(homeHtml),
      fonts: { ...extractFonts(homeHtml) },
      logo: extractLogo(homeHtml, baseUrl),
      socialLinks: extractSocialLinks(homeHtml),
      software: fingerprintSoftware(homeHtml),
      analytics: detectAnalytics(homeHtml),
      fontFiles: [],
    });

    // --- persist crawl bundle
    await writeJson(path.join(crawlDir, "identity.json"), identity);
    await writeJson(path.join(crawlDir, "brand.json"), brand);
    await writeJson(path.join(crawlDir, "pages.json"), inventory);
    await writeJson(path.join(crawlDir, "links.json"), linkMap);
    console.log(`[intake] Link map: ${linkMap.nodes.length} internal URLs (${linkMap.nodes.filter((n) => n.crawled).length} crawled, ${linkMap.nodes.filter((n) => !n.crawled).length} mapped-only)`);
    for (const doc of pageDocs) await writeJson(path.join(pagesDir, `${doc.slug}.json`), doc);
  }

  // --- Step 5: project docs into site content
  const budgets = new Map(inventory.pages.map((p) => [p.slug, p.llmBudget] as const));
  const business = await classifyBusiness({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, brand });
  const integrations = buildIntegrations(brand);
  const context = await analyzeContext({ chat: opts.chat, model: opts.capableModel, pages: pageDocs, budgets, identity, brand });
  const { gym } = await generateSite({
    chat: opts.chat,
    model: opts.capableModel,
    pages: pageDocs,
    budgets,
    identity,
    brand,
    context,
    business,
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
