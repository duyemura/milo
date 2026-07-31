import { IdentityCrawl } from "@milo/schema";

export interface PlacesClient {
  /** Search by free-text query (gym name + city). Returns the top raw place or null. */
  searchText(query: string): Promise<unknown | null>;
  /** Resolve a photo resource name into a downloadable URI. */
  getPhotoUri(photoName: string, maxWidthPx?: number): Promise<string | null>;
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

export interface PlacesSuppliedInputs {
  gymName: string;
  city: string;
  state: string;
  country: string;
  websiteUrl?: string;
}

export function placesToIdentity(raw: unknown, supplied?: PlacesSuppliedInputs): IdentityCrawl {
  if (!raw || typeof raw !== "object") {
    return IdentityCrawl.parse({
      found: false,
      name: supplied?.gymName,
      websiteUrl: supplied?.websiteUrl,
      addressParts: {
        city: supplied?.city,
        state: supplied?.state,
        country: supplied?.country,
      },
    });
  }
  const p = raw as Record<string, any>;

  const hours = (p.regularOpeningHours?.periods ?? [])
    .filter((per: any) => per.open && per.close)
    .map((per: any) => ({
      dayOfWeek: [DAYS[per.open.day] ?? "Monday"],
      opens: hhmm(per.open.hour, per.open.minute),
      closes: hhmm(per.close.hour, per.close.minute),
    }));

  const identity: Record<string, unknown> = {
    found: true,
    name: p.displayName?.text ?? supplied?.gymName,
    formattedAddress: p.formattedAddress,
    addressParts: {
      city: supplied?.city,
      state: supplied?.state,
      country: supplied?.country,
    },
    phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber,
    geoCoordinates: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
    googleBusinessProfileUrl: p.googleMapsUri,
    websiteUrl: supplied?.websiteUrl,
    priceLevel: p.priceLevel ? PRICE_MAP[p.priceLevel] : undefined,
    rating: p.rating,
    reviewCount: p.userRatingCount,
    openingHoursSpecification: hours.length ? hours : undefined,
  };

  const photos = Array.isArray(p.photos)
    ? p.photos.map((photo: any) => ({
        name: photo.name,
        widthPx: photo.widthPx,
        heightPx: photo.heightPx,
        authorAttributions: photo.authorAttributions?.map((a: any) => ({
          displayName: a.displayName,
          uri: a.uri,
        })) ?? [],
      }))
    : undefined;

  const reviews = Array.isArray(p.reviews)
    ? p.reviews.map((review: any) => ({
        name: review.name,
        relativePublishTimeDescription: review.relativePublishTimeDescription,
        rating: review.rating,
        text: review.text
          ? { text: review.text.text, languageCode: review.text.languageCode }
          : undefined,
        authorAttribution: review.authorAttribution
          ? {
              displayName: review.authorAttribution.displayName,
              uri: review.authorAttribution.uri,
              photoUri: review.authorAttribution.photoUri,
            }
          : undefined,
      }))
    : undefined;

  identity.photos = photos;
  identity.reviews = reviews;
  identity.editorialSummary = p.editorialSummary
    ? { text: p.editorialSummary.text, languageCode: p.editorialSummary.languageCode }
    : undefined;
  identity.businessStatus = p.businessStatus;
  identity.accessibilityOptions = p.accessibilityOptions
    ? {
        wheelchairAccessibleEntrance: p.accessibilityOptions.wheelchairAccessibleEntrance,
        wheelchairAccessibleParking: p.accessibilityOptions.wheelchairAccessibleParking,
      }
    : undefined;
  identity.primaryType = p.primaryType;
  identity.types = p.types;

  return IdentityCrawl.parse(identity);
}

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const DETAIL_FIELD_MASK = [
  "id", "displayName", "formattedAddress", "addressComponents", "internationalPhoneNumber",
  "nationalPhoneNumber", "location", "googleMapsUri", "websiteUri", "priceLevel", "rating",
  "userRatingCount", "regularOpeningHours", "photos", "reviews", "editorialSummary",
  "businessStatus", "accessibilityOptions", "primaryType", "types",
].join(",");

function placesHeaders(apiKey: string, fieldMask: string = DETAIL_FIELD_MASK) {
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask": fieldMask,
  };
}

export function createRealPlacesClient(apiKey: string): PlacesClient {
  return {
    async searchText(query: string): Promise<unknown | null> {
      // Google returns photo names usable by the media endpoint only from the
      // initial searchText call; the names from a follow-up getPlace are rejected
      // as invalid. Request every field we need here in one round-trip.
      const res = await fetch(PLACES_URL, {
        method: "POST",
        headers: placesHeaders(apiKey, `places.${DETAIL_FIELD_MASK.replace(/,/g, ",places.")}`),
        body: JSON.stringify({ textQuery: query }),
      });
      if (!res.ok) throw new Error(`Places API error ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { places?: unknown[] };
      return body.places?.[0] ?? null;
    },
    async getPhotoUri(photoName: string, maxWidthPx = 1600): Promise<string | null> {
      // The returned photoUri is a short-lived Google-hosted URL. Never persist
      // it in the crawl bundle; always download the bytes and reference localPath.
      // Photo resource names include unencoded slashes and must NOT be double-encoded.
      const res = await fetch(`https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`, {
        headers: { "X-Goog-Api-Key": apiKey },
      });
      if (!res.ok) {
        console.warn(`[intake] Places photo request failed: ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { photoUri?: string };
      return body.photoUri ?? null;
    },
  };
}
