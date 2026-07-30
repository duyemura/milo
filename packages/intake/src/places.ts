import { IdentityCrawl } from "@milo/schema";

/** Injected Places client. Real one hits Places API (New); fake used in tests. */
export interface PlacesClient {
  /** Search by free-text query (gym name + city). Returns the top raw place or null. */
  searchText(query: string): Promise<unknown | null>;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PRICE_MAP: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

function hhmm(hour = 0, minute = 0): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function placesToIdentity(raw: unknown): IdentityCrawl {
  if (!raw || typeof raw !== "object") return IdentityCrawl.parse({ found: false });
  const p = raw as Record<string, any>;

  const hours = (p.regularOpeningHours?.periods ?? [])
    .filter((per: any) => per.open && per.close)
    .map((per: any) => ({
      dayOfWeek: [DAYS[per.open.day] ?? "Monday"],
      opens: hhmm(per.open.hour, per.open.minute),
      closes: hhmm(per.close.hour, per.close.minute),
    }));

  return IdentityCrawl.parse({
    found: true,
    name: p.displayName?.text,
    formattedAddress: p.formattedAddress,
    phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber,
    geoCoordinates: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
    mapsUrl: p.googleMapsUri,
    googleBusinessProfileUrl: p.googleMapsUri,
    priceLevel: p.priceLevel ? PRICE_MAP[p.priceLevel] : undefined,
    rating: p.rating,
    reviewCount: p.userRatingCount,
    openingHoursSpecification: hours.length ? hours : undefined,
  });
}

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.displayName", "places.formattedAddress", "places.internationalPhoneNumber",
  "places.nationalPhoneNumber", "places.location", "places.googleMapsUri",
  "places.priceLevel", "places.rating", "places.userRatingCount", "places.regularOpeningHours",
].join(",");

export function createRealPlacesClient(apiKey: string): PlacesClient {
  return {
    async searchText(query: string): Promise<unknown | null> {
      const res = await fetch(PLACES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify({ textQuery: query }),
      });
      if (!res.ok) throw new Error(`Places API error ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { places?: unknown[] };
      return body.places?.[0] ?? null;
    },
  };
}
