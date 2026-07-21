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
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
});
