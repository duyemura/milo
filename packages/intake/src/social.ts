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
  /** Up to a few recent post image URLs (best-effort; often empty). */
  postImages?: string[];
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

/** Best-effort public Instagram profile scrape from meta tags. */
async function scrapeInstagram(url: string): Promise<SocialProfile | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const title = metaContent(html, "property", "og:title");
    const description = metaContent(html, "property", "og:description");
    const image = metaContent(html, "property", "og:image");
    // Description often contains follower stats + bio, separated by newlines/pipes.
    const bio = description ? decodeEntities(description.split("\n")[0].split("|")[0].trim()) : "";
    const { captions, images } = extractInstagramPosts(html);
    return {
      platform: "instagram",
      url,
      handle: handleFromUrl(url),
      bio: bio || title || "",
      profileImage: image || undefined,
      recentPosts: captions,
      postImages: images.length > 0 ? images : undefined,
    };
  } catch (err) {
    console.warn(`[intake] social scrape failed ${url}: ${(err as Error).message}`);
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
