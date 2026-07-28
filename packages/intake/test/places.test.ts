import { describe, it, expect } from "vitest";
import { placesToIdentity } from "../src/places.ts";

const raw = {
  displayName: { text: "Iron Anchor CrossFit" },
  formattedAddress: "123 Dock St, Denver, CO 80202, USA",
  internationalPhoneNumber: "+1 303-555-0100",
  location: { latitude: 39.75, longitude: -104.99 },
  googleMapsUri: "https://maps.google.com/?cid=123",
  priceLevel: "PRICE_LEVEL_MODERATE",
  rating: 4.9,
  userRatingCount: 212,
  regularOpeningHours: {
    periods: [
      { open: { day: 1, hour: 5, minute: 0 }, close: { day: 1, hour: 21, minute: 0 } },
    ],
  },
};

describe("placesToIdentity", () => {
  it("maps a Places (New) result into IdentityCrawl", () => {
    const id = placesToIdentity(raw);
    expect(id.found).toBe(true);
    expect(id.name).toBe("Iron Anchor CrossFit");
    expect(id.phone).toBe("+1 303-555-0100");
    expect(id.geoCoordinates).toEqual({ lat: 39.75, lng: -104.99 });
    expect(id.priceLevel).toBe("$$");
    expect(id.reviewCount).toBe(212);
    expect(id.openingHoursSpecification?.[0]).toEqual({ dayOfWeek: ["Monday"], opens: "05:00", closes: "21:00" });
  });

  it("returns found:false for null input", () => {
    expect(placesToIdentity(null).found).toBe(false);
  });
});
