import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Cta from "../components/Cta.astro";

test("Cta renders heading + button, token-driven", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Cta, {
    props: { heading: "Ready to start?", cta: { label: "Book your free intro", href: "/start" } },
  });
  expect(html).toContain("Ready to start?");
  expect(html).toContain("Book your free intro");
  expect(html).toMatch(/href="\/start"/);
  expect(html).toMatch(/var\(--color-/);
});
