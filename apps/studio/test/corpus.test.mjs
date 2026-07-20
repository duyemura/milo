import { test, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { segmentPage } from "../src/segment.mjs";
import { resolveFonts } from "../src/fonts.mjs";

const expected = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "corpus.expected.json")),
);
const urls = {
  "beanburito.github.io": "https://beanburito.github.io/free-intro-session-self-book-in-person/",
  "pushpress-site-modern.webflow.io": "https://pushpress-site-modern.webflow.io/",
  "speakeasyofstrength.com": "https://speakeasyofstrength.com/",
};

let browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

for (const [host, exp] of Object.entries(expected)) {
  test(`corpus: ${host} segments cleanly`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(urls[host], { waitUntil: "load", timeout: 120000 });
    await page.waitForTimeout(2500);
    const total = await page.evaluate(() => document.body.scrollHeight);
    const sections = await page.evaluate(segmentPage);
    const fonts = await page.evaluate(resolveFonts);
    await page.close();

    expect(sections.length).toBeGreaterThanOrEqual(exp.minSections);
    expect(sections.length).toBeLessThanOrEqual(exp.maxSections);
    if (exp.noMonster) {
      expect(Math.max(...sections.map((s) => s.height))).toBeLessThan(total * 0.9);
    }
    for (const fam of exp.fontFamilies ?? []) {
      const all = [...fonts.faces, ...fonts.loaded].map((f) => f.family);
      expect(all.some((f) => f.includes(fam))).toBe(true);
    }
  }, 180000);
}
