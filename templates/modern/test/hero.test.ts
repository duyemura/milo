import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Hero from "../components/Hero.astro";

test("Hero renders heading + CTA and uses token vars, not hardcoded color", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Hero, {
    props: { heading: "Get strong in Denver", sub: "Coached group CrossFit.", cta: { label: "Book intro", href: "/start" }, image: "assets/hero.webp" },
  });
  expect(html).toContain("Get strong in Denver");
  expect(html).toMatch(/href="\/start"/);
  expect(html).toContain("Book intro");
  expect(html).toMatch(/var\(--color-/);
  expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
});
