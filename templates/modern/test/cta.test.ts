import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Cta from "../components/Cta.astro";

const ctaSrc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/Cta.astro"), "utf8");
const ctaStyle = ctaSrc.slice(ctaSrc.indexOf("<style"));

test("Cta renders heading + button, token-driven", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Cta, {
    props: { heading: "Ready to start?", cta: { label: "Book your free intro", href: "/start" } },
  });
  expect(html).toContain("Ready to start?");
  expect(html).toContain("Book your free intro");
  expect(html).toMatch(/href="\/start"/);
  // token-driven: styles reference custom properties and use no raw color literals
  expect(ctaStyle).toMatch(/var\(--color-/);
  expect(ctaStyle).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 3/4/6/8-digit hex
  expect(ctaStyle).not.toMatch(/\brgba?\s*\(/);        // rgb/rgba
  expect(ctaStyle).not.toMatch(/\bhsla?\s*\(/);        // hsl/hsla
  expect(ctaStyle).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);
});
