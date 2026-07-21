import { test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
// axe-core is CJS; createRequire gives us the .source string to inject into the page
const axe = require("axe-core") as { source: string };

const RENDERER = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(RENDERER, "dist", "index.html");
const GYM = path.resolve(RENDERER, "../../packages/schema/fixtures/iron-anchor.json");

beforeAll(() => {
  execFileSync("pnpm", ["build"], {
    cwd: RENDERER,
    env: { ...process.env, GYM_JSON: GYM },
    stdio: "inherit",
  });
}, 120_000);

test("head SEO gate: title, meta description, canonical present", () => {
  const html = readFileSync(DIST, "utf8");
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html).toMatch(/<meta name="description" content="[^"]+"/);
  expect(html).toMatch(/<link rel="canonical" href="[^"]+"/);
});

test("AEO gate: FAQPage JSON-LD is valid and well-formed", () => {
  const html = readFileSync(DIST, "utf8");
  // Faq.astro escapes </script> as <\/script> inside the payload — unescape before parsing
  const blocks = [
    ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
  ].map((m) => JSON.parse(m[1].replace(/<\\\/script>/g, "</script>")));
  const faq = blocks.find((b) => b["@type"] === "FAQPage");
  expect(faq).toBeTruthy();
  expect(faq.mainEntity.length).toBeGreaterThan(0);
});

test("a11y gate: axe finds 0 serious/critical violations", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("file://" + DIST);
  await page.addScriptTag({ content: axe.source });
  const results = await page.evaluate(async () => await (window as any).axe.run());
  await browser.close();
  const severe = results.violations.filter(
    (v: any) => v.impact === "serious" || v.impact === "critical",
  );
  expect(severe, JSON.stringify(severe.map((v: any) => v.id))).toHaveLength(0);
}, 30_000);
