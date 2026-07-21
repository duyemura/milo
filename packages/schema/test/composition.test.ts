import { test, expect } from "vitest";
import { Page, GymDocuments } from "../src/composition.ts";

const page = {
  slug: "index",
  title: "Iron Anchor CrossFit — Denver",
  meta: { description: "Coached group CrossFit in Denver." },
  sections: [
    { section: "hero", content: { heading: "Get strong", image: "assets/hero.webp" } },
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
