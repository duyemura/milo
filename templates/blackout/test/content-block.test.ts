import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ContentBlock from "../components/ContentBlock.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/ContentBlock.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("ContentBlock renders heading and body HTML", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(ContentBlock, {
    props: {
      heading: "Our story",
      body: "<p>Iron Anchor started in 2015.</p><p>We believe in <strong>coaching</strong>.</p>",
    },
  });
  expect(html).toContain("Our story");
  expect(html).toContain("Iron Anchor started in 2015.");
  expect(html).toContain("<strong>coaching</strong>");
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/)
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);;
  // accent left border on heading
  expect(styleBlock).toContain("var(--color-accent)");
  // Oswald font
  expect(styleBlock).toContain("Oswald");
});

test("ContentBlock renders without heading", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(ContentBlock, {
    props: {
      body: "<p>Just some body text.</p>",
    },
  });
  expect(html).toContain("Just some body text.");
  expect(html).not.toContain("<h2");
});
