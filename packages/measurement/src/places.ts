import type { HttpResponse } from "./http.ts";

type FetchLike = (url: string) => Promise<HttpResponse>;

export interface PlaceMetrics {
  placeId: string;
  rating: number | null;
  reviewCount: number;
  recentReviewSnippet: string | null;
}

/**
 * Places-API metrics everyone can call TODAY (no restricted GBP program):
 * public rating + review volume + a recent review snippet for veteran voice.
 * Private insights (calls/directions) gate on Google's approval — gbp.ts's job.
 */
export async function fetchPlaceMetrics(opts: {
  apiKey: string;
  gymName: string;
  city: string;
  state: string;
  fetchFn?: FetchLike;
}): Promise<PlaceMetrics | null> {
  const fetchFn: FetchLike = opts.fetchFn ?? ((url) => fetch(url) as never);
  const query = encodeURIComponent(`${opts.gymName}, ${opts.city}, ${opts.state}`);
  const search = await fetchFn(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${opts.apiKey}`,
  );
  const sData = (await search.json()) as { results?: { place_id: string }[] };
  const placeId = sData.results?.[0]?.place_id;
  if (!placeId) return null;

  const details = await fetchFn(
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=rating,user_ratings_total,reviews&key=${opts.apiKey}`,
  );
  const dData = (await details.json()) as {
    result?: {
      rating?: number;
      user_ratings_total?: number;
      reviews?: { rating?: number; text?: string }[];
    };
  };
  const r = dData.result ?? {};
  const best = (r.reviews ?? [])
    .filter((x) => (x.rating ?? 0) >= 4 && (x.text?.length ?? 0) > 20)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
  return {
    placeId,
    rating: r.rating ?? null,
    reviewCount: r.user_ratings_total ?? 0,
    recentReviewSnippet: best?.text ? best.text.slice(0, 220) : null,
  };
}
