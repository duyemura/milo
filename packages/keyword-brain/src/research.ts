import type { SuggestFn } from "./types.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Seed queries from the gym's activities + geography. */
export function seedQueries(activities: string[], city: string, neighborhoods: string[] = []): string[] {
  const seeds: string[] = [];
  for (const a of activities.slice(0, 8)) {
    seeds.push(`${a} ${city}`);
    seeds.push(`${a} classes ${city}`);
    for (const n of neighborhoods.slice(0, 3)) seeds.push(`${a} ${n}`);
  }
  seeds.push(`${activities[0] ?? "gym"} near me`);
  return [...new Set(seeds)];
}

const inFlight = new Map<string, Promise<string[]>>();

/**
 * Default suggest implementation: Google Autocomplete public endpoint.
 * Browser-like headers, 8s timeout, per-run in-flight dedupe. Failure → empty pool
 * (caller logs; research degrades gracefully instead of dying).
 */
export const googleSuggest: SuggestFn = async (seedQuery: string): Promise<string[]> => {
  const existing = inFlight.get(seedQuery);
  if (existing) return existing;
  const p = (async (): Promise<string[]> => {
    try {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seedQuery)}`;
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as [string, string[]];
      return Array.isArray(data[1]) ? data[1].map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
    } catch {
      return [];
    } finally {
      setTimeout(() => inFlight.delete(seedQuery), 30_000);
    }
  })();
  inFlight.set(seedQuery, p);
  return p;
};

/** Mine suggestion pools for all seeds (sequential — public endpoint, be polite). */
export async function research(
  queries: string[],
  suggest: SuggestFn = googleSuggest,
  onNote?: (line: string) => void,
): Promise<{ query: string; suggestions: string[] }[]> {
  const pools: { query: string; suggestions: string[] }[] = [];
  for (const q of queries) {
    const suggestions = await suggest(q);
    if (suggestions.length > 0) pools.push({ query: q, suggestions });
    else onNote?.(`no suggestions for "${q}"`);
    await new Promise((r) => setTimeout(r, 120));
  }
  return pools;
}
