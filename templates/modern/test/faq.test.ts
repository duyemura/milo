import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Faq from "../components/Faq.astro";

test("Faq renders items and emits valid FAQPage JSON-LD", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Faq, {
    props: { items: [{ q: "What are your hours?", a: "5am to 9pm daily." }, { q: "Free intro?", a: "Yes." }] },
  });
  expect(html).toContain("What are your hours?");
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const ld = JSON.parse(m![1]);
  expect(ld["@type"]).toBe("FAQPage");
  expect(ld.mainEntity).toHaveLength(2);
  expect(ld.mainEntity[0]["@type"]).toBe("Question");
  expect(ld.mainEntity[0].acceptedAnswer["@type"]).toBe("Answer");
});
