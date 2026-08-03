import { metaContent } from "./crawl.ts";

export interface SocialProfile {
  platform: string;
  url: string;
  handle: string;
  /** Raw bio / description text from the public profile. */
  bio: string;
  /** Public profile image URL, if discoverable. */
  profileImage?: string;
  /** Up to a few recent public post captions (best-effort; often empty). */
  recentPosts: string[];
  /** Up to a few recent post image URLs (best-effort; often empty). Prefer capturedImages when present. */
  postImages?: string[];
  /**
   * Pre-fetched post image bytes captured during scraping (e.g. Playwright network interception).
   * When populated, ingestSocialImages uses these directly instead of re-downloading postImages.
   */
  capturedImages?: { altText?: string; buffer: Buffer }[];
  /** Public follower count as a string if parseable. */
  followerCount?: string;
}

/** Injected social scraper — real one does best-effort public-page meta extraction. */
export interface SocialScraper {
  scrape(url: string, platform: string): Promise<SocialProfile | null>;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function handleFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
    return path.split("/")[0] ?? url;
  } catch {
    return url;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Extract recent post captions + image URLs from whatever Instagram embeds in the page. */
export function extractInstagramPosts(html: string): { captions: string[]; images: string[] } {
  const captions: string[] = [];
  const images: string[] = [];

  // Pattern 1: window._sharedData (legacy, largely dead but still worth trying)
  for (const m of html.matchAll(/<script type="text\/javascript">window\._sharedData = ([\s\S]*?);<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]);
      const edges = data?.entry_data?.ProfilePage?.[0]?.graphql?.user?.edge_owner_to_timeline_media?.edges ?? [];
      for (const edge of edges.slice(0, 6)) {
        const text = edge?.node?.edge_media_to_caption?.edges?.[0]?.node?.text ?? "";
        if (text) captions.push(text.slice(0, 280));
        const img = edge?.node?.display_url ?? edge?.node?.thumbnail_src ?? "";
        if (img && images.length < 5) images.push(img);
      }
    } catch { /* ignore */ }
  }

  // Pattern 2: display_url / thumbnail_src scattered in any embedded JSON
  if (images.length === 0) {
    for (const m of html.matchAll(/"display_url":"(https:\\u002F\\u002F[^"]+)"/g)) {
      try {
        const url = JSON.parse(`"${m[1]}"`) as string;
        if (url.includes("cdninstagram") || url.includes("fbcdn")) {
          images.push(url);
          if (images.length >= 5) break;
        }
      } catch { /* ignore */ }
    }
  }

  return { captions, images };
}

const CDN_PATTERN = /cdninstagram|fbcdn/;

/** Best-effort public Instagram profile scrape using Playwright with network interception. */
async function scrapeInstagram(url: string): Promise<SocialProfile | null> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2, // signals high-DPR → Instagram serves larger images
        locale: "en-US",
      });
      const page = await context.newPage();

      // Intercept CDN image responses BEFORE navigation so we catch every load.
      const captureQueue: Promise<void>[] = [];
      const capturedImages: { buffer: Buffer }[] = [];
      const seenUrls = new Set<string>();

      page.on("response", (response) => {
        const resUrl = response.url();
        if (seenUrls.has(resUrl) || !CDN_PATTERN.test(resUrl)) return;
        const ct = response.headers()["content-type"] ?? "";
        if (!ct.startsWith("image/")) return;
        seenUrls.add(resUrl);
        if (captureQueue.length >= 20) return; // cap queue to avoid memory pressure
        captureQueue.push(
          response.body().then((buf) => {
            // Skip tiny images (icons, avatars, 150px thumbnails < ~10KB)
            if (buf.length >= 20_000 && capturedImages.length < 9) {
              capturedImages.push({ buffer: buf });
            }
          }).catch(() => {}),
        );
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Give React time to hydrate and lazy-load the post grid
      await page.waitForTimeout(3000);
      // Dismiss cookie banner or login modal if present
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      // Wait for all intercepted response bodies to finish reading
      await Promise.all(captureQueue);

      const profileImage = await page.$eval(
        'meta[property="og:image"]',
        (el) => el.getAttribute("content"),
      ).catch(() => null);

      const description = await page.$eval(
        'meta[property="og:description"]',
        (el) => el.getAttribute("content"),
      ).catch(() => null);

      const title = await page.$eval(
        'meta[property="og:title"]',
        (el) => el.getAttribute("content"),
      ).catch(() => null);

      const { captions } = extractInstagramPosts(await page.content());

      const bio = description
        ? decodeEntities(description.split("\n")[0].split("|")[0].trim())
        : "";

      return {
        platform: "instagram",
        url,
        handle: handleFromUrl(url),
        bio: bio || title || "",
        profileImage: profileImage || undefined,
        recentPosts: captions,
        capturedImages: capturedImages.length > 0 ? capturedImages : undefined,
      };
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn(`[intake] Instagram scrape failed ${url}: ${(err as Error).message}`);
    return null;
  }
}

/** Real scraper: best-effort, graceful degradation per platform. */
export function createRealSocialScraper(): SocialScraper {
  return {
    async scrape(url: string, platform: string): Promise<SocialProfile | null> {
      if (platform === "instagram") return scrapeInstagram(url);
      // Facebook, TikTok, YouTube, etc. can be added here without changing callers.
      console.warn(`[intake] social scrape not implemented for ${platform}: ${url}`);
      return null;
    },
  };
}
