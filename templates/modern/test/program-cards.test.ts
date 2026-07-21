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

test("ProgramCards renders program names and emits Service JSON-LD", async () => {
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
  // JSON-LD
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const ld = JSON.parse(m![1]);
  // Service schema (array or single)
  const services = Array.isArray(ld) ? ld : [ld];
  expect(services.some((s: any) => s["@type"] === "Service")).toBe(true);
  // token check — source style block must use custom properties only
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
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
  expect(html).toContain('<img');
  expect(html).toContain("https://example.com/strength.jpg");
});
