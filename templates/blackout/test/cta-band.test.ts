import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import CtaBand from "../components/CtaBand.astro";

const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/CtaBand.astro"), "utf8");
const styleBlock = src.slice(src.indexOf("<style"));

test("CtaBand renders heading + button, token-driven", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(CtaBand, {
    props: { heading: "Ready to start?", cta: { label: "Book your free intro", href: "/start" } },
  });
  expect(html).toContain("Ready to start?");
  expect(html).toContain("Book your free intro");
  expect(html).toMatch(/href="\/start"/);
  // token-driven: styles reference custom properties and use no raw color literals
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 3/4/6/8-digit hex
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);        // rgb/rgba
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);        // hsl/hsla
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);
});
