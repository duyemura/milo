import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Faq from "../components/Faq.astro";

const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/Faq.astro"), "utf8");
const styleBlock = src.slice(src.indexOf("<style"));

test("Faq renders question and answer text", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Faq, {
    props: { items: [{ q: "What are your hours?", a: "5am to 9pm daily." }, { q: "Free intro?", a: "Yes." }] },
  });
  expect(html).toContain("What are your hours?");
  expect(html).toContain("5am to 9pm daily.");
  expect(html).toContain("Free intro?");
  // FAQPage JSON-LD is emitted by the renderer @graph, not this component
  expect(html).not.toContain('"FAQPage"');
  // token check
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
});

test("Faq renders optional heading", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Faq, {
    props: { heading: "Got questions?", items: [{ q: "Q?", a: "A." }] },
  });
  expect(html).toContain("Got questions?");
});
