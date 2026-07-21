import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import LeadForm from "../components/LeadForm.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/LeadForm.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("LeadForm renders heading, fields, formId, and CTA", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(LeadForm, {
    props: {
      heading: "Book your free intro",
      sub: "No experience needed.",
      fields: [
        { name: "name", label: "Name", kind: "text", required: true },
        { name: "email", label: "Email", kind: "email", required: true },
        { name: "phone", label: "Phone", kind: "tel", required: false },
      ],
      submitLabel: "Book your free intro",
      formId: "iron-anchor-intro",
    },
  });
  expect(html).toContain("Book your free intro");
  expect(html).toContain("No experience needed.");
  expect(html).toContain('data-form-id="iron-anchor-intro"');
  expect(html).toContain('type="email"');
  expect(html).toContain('type="tel"');
  expect(html).toContain('method="post"');
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
  // accent bg section, primary bg button, sharp edges
  expect(styleBlock).toContain("var(--color-accent)");
  expect(styleBlock).toContain("var(--color-primary)");
  expect(styleBlock).toContain("border-radius: 0");
  // Oswald font
  expect(styleBlock).toContain("Oswald");
});
