import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ProgramCards from "../components/ProgramCards.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/ProgramCards.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("ProgramCards renders program names and links", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(ProgramCards, {
    props: {
      heading: "Our Programs",
      programs: [
        { slug: "crossfit", name: "CrossFit", description: "Coached group fitness.", href: "/programs/crossfit" },
        { slug: "olympic-lifting", name: "Olympic Lifting", description: "Barbell mastery." },
      ],
    },
  });
  expect(html).toContain("CrossFit");
  expect(html).toContain("Olympic Lifting");
  // Service JSON-LD is emitted by the renderer @graph, not this component
  expect(html).not.toContain('"Service"');
  // token check — source style block must use custom properties only
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/)
  expect(styleBlock).not.toMatch(/:\s*(black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent)\b/i);;
});

test("ProgramCards renders default ctaLabel and uses it in links", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(ProgramCards, {
    props: {
      programs: [
        { slug: "yoga", name: "Yoga", description: "Flexibility and mindfulness.", href: "/programs/yoga" },
      ],
    },
  });
  expect(html).toContain("Yoga");
  expect(html).toContain("Contact Us For More Info");
});

test("ProgramCards with image renders an img element", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(ProgramCards, {
    props: {
      programs: [
        {
          slug: "strength",
          name: "Strength Training",
          description: "Build real-world strength.",
          image: "https://example.com/strength.jpg",
        },
      ],
    },
  });
  expect(html).toContain("Strength Training");
  expect(html).toContain("<img");
  expect(html).toContain("https://example.com/strength.jpg");
});
