import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import LogoStrip from "../components/LogoStrip.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/LogoStrip.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("LogoStrip renders all logo images with alt text", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(LogoStrip, {
    props: {
      heading: "As seen in",
      logos: [
        { src: "assets/logo-nyt.svg", alt: "New York Times" },
        { src: "assets/logo-men-health.svg", alt: "Men's Health" },
      ],
    },
  });
  expect(html).toContain("As seen in");
  expect(html).toContain("assets/logo-nyt.svg");
  expect(html).toContain('alt="New York Times"');
  expect(html).toContain('alt="Men\'s Health"');
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
});
