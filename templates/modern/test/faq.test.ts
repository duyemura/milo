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

test("Faq escapes </script> inside JSON-LD to prevent breakout/XSS", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Faq, {
    props: { items: [{ q: "Embed?", a: "Use </script> carefully." }] },
  });
  // The literal answer text must appear escaped, not as a raw closing tag inside the JSON.
  expect(html).toContain("<\\/script>");
  // Isolate the JSON-LD payload and confirm it has no raw </script> that would break out early.
  const scriptOpen = html.indexOf('<script type="application/ld+json">');
  const payloadStart = html.indexOf(">", scriptOpen) + 1;
  const payloadEnd = html.indexOf("</script>", payloadStart);
  const payload = html.slice(payloadStart, payloadEnd);
  expect(payload).not.toContain("</script>");
  expect(payload).toContain("<\\/script>");
});
