import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PageDocument } from "./schemas.ts";

export interface FetchedPage {
  html: string;
  fetchMethod: "static" | "playwright";
}

/** Injected page fetcher — real one does static fetch + Playwright fallback. */
export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

const TRUNCATE_CHARS = 800;
const PLAYWRIGHT_THRESHOLD = 200;

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function stripBoilerplate(html: string): string {
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ");
  return stripTags(cleaned);
}

/** JS-rendered pages produce almost no static body text. */
export function needsPlaywright(html: string): boolean {
  return stripBoilerplate(html).length < PLAYWRIGHT_THRESHOLD;
}

function matchOne(html: string, re: RegExp): string {
  return (html.match(re)?.[1] ?? "").trim();
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function collectAssetUrls(html: string, pageUrl: string): string[] {
  const raw: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) raw.push(m[1]);
  const og = matchOne(html, /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i);
  if (og) raw.push(og);
  for (const m of html.matchAll(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi)) raw.push(m[1]);

  const out: string[] = [];
  for (const src of raw) {
    try {
      const abs = new URL(decodeEntities(src), pageUrl).href;
      if (!abs.startsWith("data:") && !out.includes(abs)) out.push(abs);
    } catch { /* skip */ }
  }
  return out;
}

export interface ExtractInput {
  html: string;
  url: string;
  slug: string;
  baseUrl: string;
  fetchMethod: "static" | "playwright";
  llmBudget: "full" | "truncated";
}

export function extractPageDocument(input: ExtractInput): PageDocument {
  const { html, url, slug, baseUrl, fetchMethod, llmBudget } = input;
  const origin = new URL(baseUrl).origin;

  const title = decodeEntities(matchOne(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  const metaDescription = decodeEntities(
    matchOne(html, /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i),
  );

  const headings: string[] = [];
  for (const m of html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const text = decodeEntities(stripTags(m[1]));
    if (text) headings.push(text);
  }

  let bodyText = stripBoilerplate(html);
  if (llmBudget === "truncated") bodyText = bodyText.slice(0, TRUNCATE_CHARS);

  const images = collectAssetUrls(html, url).map((src) => ({ src, alt: "", localPath: null }));
  // alt text for <img> specifically
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = matchOne(m[0], /\bsrc\s*=\s*["']([^"']+)["']/i);
    const alt = decodeEntities(matchOne(m[0], /\balt\s*=\s*["']([^"']*)["']/i));
    if (!src) continue;
    try {
      const abs = new URL(decodeEntities(src), url).href;
      const found = images.find((im) => im.src === abs);
      if (found) found.alt = alt;
    } catch { /* skip */ }
  }

  const links: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const abs = new URL(decodeEntities(m[1]), url);
      if (abs.origin === origin && !links.includes(abs.href)) links.push(abs.href);
    } catch { /* skip */ }
  }

  return PageDocument.parse({
    url, slug, title, metaDescription, headings, bodyText, images, links, fetchMethod,
    // detectedType/archetype/etc. are filled by the LLM classify step (Task 11); schema defaults apply here.
  });
}

const USER_AGENT = "Milo-Intake/1.0 (+https://pushpress.com)";

export function createRealPageFetcher(): PageFetcher {
  return {
    async fetch(url: string): Promise<FetchedPage> {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
      const html = await res.text();
      if (needsPlaywright(html)) {
        console.log(`[intake] page ${new URL(url).pathname} is JS-rendered — using Playwright`);
        const rendered = await renderWithPlaywright(url);
        if (rendered) return { html: rendered, fetchMethod: "playwright" };
      }
      return { html, fetchMethod: "static" };
    },
  };
}

/**
 * Playwright fallback. Imported lazily so unit tests (and environments without
 * Playwright installed) never load it. Reuses the chromium install from apps/studio.
 */
async function renderWithPlaywright(url: string): Promise<string | null> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ userAgent: USER_AGENT });
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      return await page.content();
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn(`[intake] Playwright fallback failed for ${url}: ${(err as Error).message}`);
    return null;
  }
}

function sanitizeAssetName(assetUrl: string): string {
  const base = path.basename(new URL(assetUrl).pathname) || "asset";
  return base.replace(/[^a-z0-9.\-_]/gi, "_");
}

/**
 * Download one asset into `assetsDir`. Returns the local path (`/assets/<name>`)
 * or null on failure. Failures are logged and skipped — never fatal.
 */
export async function downloadAsset(assetUrl: string, assetsDir: string): Promise<string | null> {
  try {
    const res = await fetch(assetUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await mkdir(assetsDir, { recursive: true });
    const name = sanitizeAssetName(assetUrl);
    await writeFile(path.join(assetsDir, name), Buffer.from(await res.arrayBuffer()));
    return `/assets/${name}`;
  } catch (err) {
    console.warn(`[intake] asset download failed ${assetUrl}: ${(err as Error).message}`);
    return null;
  }
}
