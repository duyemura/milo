import { LinkMap } from "./schemas.ts";
import type { LinkMap as LinkMapT } from "./schemas.ts";
import { isUgc, slugFor } from "./discover.ts";

function sameOrigin(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}

export interface NextToCrawlInput {
  baseUrl: string;
  newLinks: string[];
  alreadyQueued: Set<string>;   // URLs already crawled or enqueued
  remaining: number;            // max-pages minus already-committed count
  includeUgc: boolean;
}

/** Pure planner: which newly-seen links should join the crawl queue this round. */
export function nextToCrawl(input: NextToCrawlInput): string[] {
  const origin = new URL(input.baseUrl).origin;
  const out: string[] = [];
  const seen = new Set(input.alreadyQueued);
  for (const link of input.newLinks) {
    if (out.length >= input.remaining) break;
    if (!sameOrigin(link, origin)) continue;
    if (seen.has(link)) continue;
    if (!input.includeUgc && isUgc(link)) continue;
    seen.add(link);
    out.push(link);
  }
  return out;
}

export interface BuildLinkMapInput {
  baseUrl: string;
  discoveredAt: string;
  crawledSlugs: Map<string, string>;         // url -> slug for pages actually crawled
  pageLinks: Map<string, string[]>;          // url -> same-origin links found on it
}

/** Build the full internal link graph — every same-origin URL seen, crawled or not. */
export function buildLinkMap(input: BuildLinkMapInput): LinkMapT {
  const origin = new URL(input.baseUrl).origin;
  const nodeUrls = new Set<string>();
  const edges: { from: string; to: string }[] = [];

  for (const [from, tos] of input.pageLinks) {
    // Keys are same-origin crawled pages by construction; guard defensively so a
    // stray cross-origin (or malformed) key can never inject a bogus node/edge.
    if (!sameOrigin(from, origin)) continue;
    nodeUrls.add(from);
    for (const to of tos) {
      if (!sameOrigin(to, origin)) continue;
      nodeUrls.add(to);
      edges.push({ from, to });
    }
  }
  // Ensure every crawled url is a node even if nothing linked to it.
  for (const url of input.crawledSlugs.keys()) nodeUrls.add(url);

  const nodes = [...nodeUrls].map((url) => ({
    url,
    slug: input.crawledSlugs.get(url) ?? slugFor(url, input.baseUrl),
    crawled: input.crawledSlugs.has(url),
    isUgc: isUgc(url),
  }));

  return LinkMap.parse({ baseUrl: input.baseUrl, discoveredAt: input.discoveredAt, nodes, edges });
}
