import type { Asset, AssetLibrary, AssetTags } from "./library.ts";

export interface FindQuery {
  aspectRatio?: Asset["aspectRatio"];
  setting?: AssetTags["setting"];
  hasPeople?: boolean;
  usableContext?: "generated-safe" | "any";
  minQuality?: "low" | "medium" | "high";
  embedding?: number[];
  limit?: number;
  /**
   * Scope results to assets from a specific site or generic (no siteOrigin) assets.
   * Pass the site slug (e.g. "speakeasy-brooklyn") to exclude other locations' photos.
   * Generic assets (equipment, food, AI-generated) always pass this filter.
   */
  siteId?: string;
  /**
   * Free-text search across description, subjects, mood, and activity.
   * ALL words must appear somewhere in the combined searchable text (case-insensitive).
   * This bridges semantic gaps (e.g. "members celebrating" matches a description mentioning
   * "members" and mood "celebratory") without requiring embeddings.
   */
  text?: string;
}

const QUALITY_ORDER = { low: 0, medium: 1, high: 2 } as const;

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function searchableText(tags: AssetTags): string {
  return [tags.description, ...tags.subjects, ...tags.mood, tags.activity ?? ""].join(" ").toLowerCase();
}

function matchesText(tags: AssetTags, text: string): boolean {
  const haystack = searchableText(tags);
  return text.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

export function findAsset(library: AssetLibrary, query: FindQuery): Asset[] {
  const candidates = Object.values(library.assets).filter((a) => {
    if (a.status !== "active") return false;
    if (query.aspectRatio !== undefined && a.aspectRatio !== query.aspectRatio) return false;
    if (query.setting !== undefined && a.tags.setting !== query.setting) return false;
    if (query.hasPeople !== undefined && a.tags.hasPeople !== query.hasPeople) return false;
    if (query.usableContext === "generated-safe" && a.tags.hasPeople) return false;
    if (query.minQuality !== undefined && QUALITY_ORDER[a.tags.quality] < QUALITY_ORDER[query.minQuality]) return false;
    if (query.text !== undefined && !matchesText(a.tags, query.text)) return false;
    // Site scoping: generic assets (no siteOrigin) are always included; location-specific
    // assets only match when their siteOrigin matches the requested siteId.
    if (query.siteId !== undefined && a.siteOrigin !== undefined && a.siteOrigin !== query.siteId) return false;
    return true;
  });

  const useEmbedding = query.embedding && candidates.every((a) => a.tags.embedding);
  candidates.sort((x, y) => {
    if (useEmbedding && x.tags.embedding && y.tags.embedding) {
      return cosine(y.tags.embedding, query.embedding!) - cosine(x.tags.embedding, query.embedding!);
    }
    return new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime();
  });

  return query.limit !== undefined ? candidates.slice(0, query.limit) : candidates;
}
