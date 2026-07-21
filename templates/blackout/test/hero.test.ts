import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Hero from "../components/Hero.astro";

const heroSrc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/Hero.astro"), "utf8");
const heroStyle = heroSrc.slice(heroSrc.indexOf("<style"));

test("Hero renders heading + CTA and uses token vars, not hardcoded color", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Hero, {
    props: { heading: "Get strong in Denver", sub: "Coached group CrossFit.", cta: { label: "Book intro", href: "/start" }, image: { src: "assets/hero.webp", alt: "Gym hero image" } },
  });
  expect(html).toContain("Get strong in Denver");
  expect(html).toMatch(/href="\/start"/);
  expect(html).toContain("Book intro");
  // token-driven: styles reference custom properties and use no raw color literals
  expect(heroStyle).toMatch(/var\(--color-/);
  expect(heroStyle).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 3/4/6/8-digit hex
  expect(heroStyle).not.toMatch(/\brgba?\s*\(/);        // rgb/rgba
  expect(heroStyle).not.toMatch(/\bhsla?\s*\(/);        // hsl/hsla
  expect(heroStyle).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);
});

test("Hero renders optional kicker", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Hero, {
    props: { heading: "Train hard", kicker: "Denver No.1 gym", image: { src: "assets/hero.webp", alt: "Gym hero image" } },
  });
  expect(html).toContain("Denver No.1 gym");
  expect(html).toContain("Train hard");
});
