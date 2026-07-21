import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import MediaBlock from "../components/MediaBlock.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/MediaBlock.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("MediaBlock renders heading, body, image, and optional CTA", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(MediaBlock, {
    props: {
      heading: "Train like an athlete",
      body: "Our programming is designed by coaches with decades of experience.",
      image: "assets/training.webp",
      mediaSide: "right",
      cta: { label: "See the programming", href: "/programming" },
    },
  });
  expect(html).toContain("Train like an athlete");
  expect(html).toContain("Our programming is designed by coaches");
  expect(html).toContain("assets/training.webp");
  expect(html).toContain("See the programming");
  expect(html).toMatch(/href="\/programming"/);
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/)
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);;
});
