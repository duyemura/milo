import type { HttpResponse } from "./http.ts";

export interface PlaceMetrics {
  placeId: string;
  rating: number | null;
  reviewCount: number;
  recentReviewSnippet: string | null;
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

/**
 * Places API (New) Text Search — legacy Places endpoints are disabled on new projects;
 * this path works with just an api key (no GBP restricted-access program). Public
 * ratings/review volume + a review highlight for veteran voice.
 */
export async function fetchPlaceMetrics(opts: {
  apiKey: string;
  gymName: string;
  city: string;
  state: string;
  fetchFn?: FetchLike;
}): Promise<PlaceMetrics | null> {
  const fetchFn: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init as never) as never);
  const res = await fetchFn("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": opts.apiKey,
      "x-goog-fieldmask": "places.id,places.displayName,places.rating,places.userRatingCount,places.reviews",
    },
    body: JSON.stringify({
      textQuery: `${opts.gymName}, ${opts.city}, ${opts.state}`,
      maxResultCount: 5,
    }),
  });
  const data = (await res.json()) as {
    places?: {
      id: string;
      rating?: number;
      userRatingCount?: number;
      reviews?: { rating?: number; text?: { text?: string } }[];
    }[];
    error?: { message?: string };
  };
  const place = data.places?.[0];
  if (!place) {
    if (data.error?.message) {
      const err = new Error(`places searchText: ${data.error.message}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return null;
  }
  const best = (place.reviews ?? [])
    .filter((x) => (x.rating ?? 0) >= 4 && (x.text?.text?.length ?? 0) > 20)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
  return {
    placeId: place.id,
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? 0,
    recentReviewSnippet: best?.text?.text ? best.text.text.slice(0, 220) : null,
  };
}
