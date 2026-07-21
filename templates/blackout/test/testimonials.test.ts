import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Testimonials from "../components/Testimonials.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/Testimonials.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("Testimonials renders quotes and author names", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Testimonials, {
    props: {
      heading: "What members say",
      reviews: [
        { name: "Alice Kim", quote: "Best gym in Denver.", rating: 5 },
        { name: "Bob Torres", quote: "Changed my life.", source: "Google", rating: 4 },
      ],
    },
  });
  expect(html).toContain("Alice Kim");
  expect(html).toContain("Best gym in Denver.");
  expect(html).toContain("Bob Torres");
  expect(html).toContain("Google");
  // Review JSON-LD is emitted by the renderer @graph, not this component
  expect(html).not.toContain('"Review"');
  // token check — source style block must use custom properties only
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/)
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);;
});

test("Testimonials renders star ratings", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Testimonials, {
    props: {
      heading: "Reviews",
      reviews: [
        { name: "Star Tester", quote: "Five stars all day.", rating: 5 },
      ],
    },
  });
  expect(html).toContain("★");
  expect(html).toContain("5 out of 5 stars");
});

test("Testimonials renders heading", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Testimonials, {
    props: {
      heading: "Member Reviews",
      reviews: [{ name: "Dan", quote: "Great place.", rating: 5 }],
    },
  });
  expect(html).toContain("Member Reviews");
});

test("Testimonials omits source when not provided", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Testimonials, {
    props: {
      heading: "Reviews",
      reviews: [{ name: "No Source", quote: "No source here.", rating: 4 }],
    },
  });
  expect(html).toContain("No Source");
  expect(html).not.toContain("Google");
  expect(html).not.toContain("Yelp");
});
