import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import LocationMap from "../components/LocationMap.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/LocationMap.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("LocationMap renders address, hours, phone, and CTA", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(LocationMap, {
    props: {
      heading: "Find us",
      address: "1234 Anchor St, Denver, CO 80202",
      hours: ["Mon–Fri: 5am–9pm", "Sat–Sun: 7am–5pm"],
      phone: "(303) 555-0100",
      cta: { label: "Get directions", href: "https://maps.google.com/?q=1234+Anchor+St" },
    },
  });
  expect(html).toContain("1234 Anchor St");
  expect(html).toContain("Mon–Fri: 5am–9pm");
  expect(html).toContain("(303) 555-0100");
  // LocalBusiness JSON-LD lives at page level (@graph in renderer) — not in this component
  expect(html).not.toContain('"LocalBusiness"');
  // token check — source style block must use custom properties only
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
});

test("LocationMap renders iframe when mapEmbedUrl is provided", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(LocationMap, {
    props: {
      address: "999 Fitness Way, Austin, TX 78701",
      mapEmbedUrl: "https://www.google.com/maps/embed?pb=test123",
    },
  });
  expect(html).toContain("<iframe");
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('title="Location map"');
  expect(html).toContain("test123");
});

test("LocationMap renders address text when no mapEmbedUrl", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(LocationMap, {
    props: {
      address: "42 Barbell Blvd, Chicago, IL 60601",
    },
  });
  expect(html).not.toContain("<iframe");
  expect(html).toContain("42 Barbell Blvd");
});

test("LocationMap renders CTA link when provided", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(LocationMap, {
    props: {
      address: "1 Main St, Portland, OR 97201",
      cta: { label: "Get directions", href: "https://maps.google.com/?q=1+Main+St" },
    },
  });
  expect(html).toContain("Get directions");
  expect(html).toContain("https://maps.google.com/?q=1+Main+St");
});

test("LocationMap renders hours list", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(LocationMap, {
    props: {
      address: "55 Flex St, Seattle, WA 98101",
      hours: ["Mon–Fri: 6am–8pm", "Sat: 8am–4pm"],
    },
  });
  expect(html).toContain("Mon–Fri: 6am–8pm");
  expect(html).toContain("Sat: 8am–4pm");
  expect(html).not.toContain('"LocalBusiness"');
});
