import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Faq from "../components/Faq.astro";

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
});

test("Faq renders optional heading", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Faq, {
    props: { heading: "Got questions?", items: [{ q: "Q?", a: "A." }] },
  });
  expect(html).toContain("Got questions?");
});
