import { test, expect } from "vitest";
import { Page, GymDocuments } from "../src/composition.ts";

const page = {
  slug: "index",
  title: "Iron Anchor CrossFit — Denver",
  meta: { description: "Coached group CrossFit in Denver." },
  sections: [
    { section: "hero", content: { heading: "Get strong", image: { src: "assets/hero.webp", alt: "Gym hero" } } },
    { section: "faq", content: { items: [{ q: "Hours?", a: "5am-9pm." }] } },
  ],
};

test("Page validates ordered section instances", () => {
  expect(() => Page.parse(page)).not.toThrow();
});

test("Page rejects an unknown section type", () => {
  const bad = { ...page, sections: [{ section: "carousel-3d", content: {} }] };
  expect(() => Page.parse(bad)).toThrow();
});

test("GymDocuments requires identity, brand tokens, and a hierarchy", () => {
  const docs = {
    identity: { name: "Iron Anchor", tagline: "Coached strength" },
    brand: { colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
             fonts: { display: "Montserrat", body: "Inter" },
             space: { sm: "8px", md: "16px", lg: "32px" }, radius: { button: "10px", card: "12px" } },
    hierarchy: { pages: [page] },
  };
  expect(() => GymDocuments.parse(docs)).not.toThrow();
});

test("GymDocuments accepts new local SEO fields", () => {
  const docs = {
    identity: {
      name: "Iron Anchor CrossFit",
      tagline: "Coached strength in Denver",
      areaServed: ["Denver, CO", "LoDo"],
      sports: ["CrossFit", "Olympic Weightlifting"],
      email: "info@ironanchor.com",
      foundingDate: "2015-06-01",
      openingHoursSpecification: [
        { dayOfWeek: ["Monday", "Friday"], opens: "05:00", closes: "21:00" },
      ],
    },
    brand: {
      colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
      fonts: { display: "Montserrat", body: "Inter" },
      space: { sm: "8px", md: "16px", lg: "32px" },
      radius: { button: "10px", card: "12px" },
    },
    hierarchy: { pages: [{ slug: "index", title: "Iron Anchor", meta: { description: "CrossFit in Denver." }, sections: [{ section: "hero", content: { heading: "Get strong", image: { src: "assets/hero.webp", alt: "Gym hero" } } }] }] },
  };
  expect(() => GymDocuments.parse(docs)).not.toThrow();
});

test("GymDocuments accepts optional identity SEO fields", () => {
  const docs = {
    identity: {
      name: "Iron Anchor CrossFit",
      tagline: "Coached strength in Denver",
      siteUrl: "https://ironanchor.com",
      phone: "(720) 555-0142",
      address: "1234 Anchor St, Denver, CO 80202",
      addressParts: {
        street: "1234 Anchor St",
        city: "Denver",
        state: "CO",
        zip: "80202",
        country: "US",
      },
      geoCoordinates: { lat: 39.7392, lng: -104.9903 },
      mapsUrl: "https://maps.google.com/?q=1234+Anchor+St+Denver+CO+80202",
      googleBusinessProfileUrl: "https://g.page/iron-anchor-crossfit",
      priceRange: "$$",
      ogImage: "https://ironanchor.com/og.jpg",
      favicon: "/favicon.svg",
      themeColor: "#0b1f3a",
      socialProfiles: ["https://instagram.com/ironanchor", "https://facebook.com/ironanchor"],
    },
    brand: {
      colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
      fonts: { display: "Montserrat", body: "Inter" },
      space: { sm: "8px", md: "16px", lg: "32px" },
      radius: { button: "10px", card: "12px" },
    },
    hierarchy: { pages: [{ slug: "index", title: "Iron Anchor", meta: { description: "CrossFit in Denver." }, sections: [{ section: "hero", content: { heading: "Get strong", image: { src: "assets/hero.webp", alt: "Gym hero" } } }] }] },
  };
  expect(() => GymDocuments.parse(docs)).not.toThrow();
});
