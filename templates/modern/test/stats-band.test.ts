import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { contrastOk } from "@milo/schema";
import StatsBand from "../components/StatsBand.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/StatsBand.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("StatsBand renders all stat values and labels, token-driven", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(StatsBand, {
    props: {
      stats: [
        { value: "500+", label: "Members" },
        { value: "8", label: "Years open" },
        { value: "3", label: "Locations" },
      ],
    },
  });
  expect(html).toContain("500+");
  expect(html).toContain("Members");
  expect(html).toContain("Years open");
  expect(html).toContain("3");
  expect(html).toContain("Locations");
  // token check — source style block must reference custom properties and no raw color literals
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/)
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);;
});

test("StatsBand uses --color-on-primary for stat values and labels with AA contrast", async () => {
  const container = await AstroContainer.create();
  await container.renderToString(StatsBand, {
    props: {
      stats: [
        { value: "500+", label: "Members" },
      ],
    },
  });
  expect(styleBlock).toMatch(/\.stat-value\s*\{[^}]*color:\s*var\(--color-on-primary\)/);
  expect(styleBlock).toMatch(/\.stat-label\s*\{[^}]*color:\s*var\(--color-on-primary\)/);
  // on-primary is a semantic alias for surface; verify a representative dark-primary / light-surface pair passes AA.
  expect(contrastOk("#ffffff", "#0b1f3a")).toBe(true);
});
