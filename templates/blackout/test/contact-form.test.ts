import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ContactForm from "../components/ContactForm.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/ContactForm.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("ContactForm renders fields and submit button", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(ContactForm, {
    props: {
      heading: "Get in touch",
      sub: "We will get back to you within 24 hours.",
      fields: [
        { name: "name", label: "Name", kind: "text", required: true },
        { name: "email", label: "Email", kind: "email", required: true },
        { name: "message", label: "Message", kind: "textarea", required: false },
      ],
      submitLabel: "Send message",
    },
  });
  expect(html).toContain("Get in touch");
  // Astro HTML-encodes apostrophes as &#39; — check unique fragment that avoids the apostrophe
  expect(html).toContain("get back to you within 24 hours.");

  expect(html).toContain('type="text"');
  expect(html).toContain('type="email"');
  expect(html).toContain("<textarea");
  expect(html).toContain("Send message");
  expect(html).toContain('method="post"');
  expect(html).toContain('action="#"');
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
  // Blackout: accent border on inputs, no border-radius
  expect(styleBlock).toContain("var(--color-accent)");
  expect(styleBlock).toContain("border-radius: 0");
  // Oswald font on submit
  expect(styleBlock).toContain("Oswald");
});
