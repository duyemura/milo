import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import FeatureGrid from "../components/FeatureGrid.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/FeatureGrid.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("FeatureGrid renders items with titles and body text", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(FeatureGrid, {
    props: {
      heading: "Why us",
      items: [
        { title: "Expert coaching", body: "CF-L3 certified coaches.", icon: "🏋️" },
        { title: "Community", body: "Hundreds of members." },
      ],
    },
  });
  expect(html).toContain("Expert coaching");
  expect(html).toContain("CF-L3 certified coaches.");
  expect(html).toContain("Community");
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/)
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);;
});

test("FeatureGrid numbered variant renders number prefix", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(FeatureGrid, {
    props: {
      variant: "numbered",
      items: [
        { title: "Step one", body: "First thing." },
        { title: "Step two", body: "Second thing." },
      ],
    },
  });
  expect(html).toContain("01");
  expect(html).toContain("02");
  expect(html).toContain("Step one");
  expect(html).toContain("Step two");
});
