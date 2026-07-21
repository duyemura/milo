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
    props: { heading: "Get strong in Denver", sub: "Coached group CrossFit.", cta: { label: "Book intro", href: "/start" }, image: "assets/hero.webp" },
  });
  expect(html).toContain("Get strong in Denver");
  expect(html).toMatch(/href="\/start"/);
  expect(html).toContain("Book intro");
  // token-driven: styles reference custom properties and use no raw hex
  expect(heroStyle).toMatch(/var\(--color-/);
  expect(heroStyle).not.toMatch(/#[0-9a-fA-F]{6}/);
});
