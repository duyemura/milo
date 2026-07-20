import { test, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveFonts, fontFileUrls } from "../src/fonts.mjs";

const fixture = (name) =>
  "file://" + path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

let browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

test("resolves @font-face families even without <link> tags", async () => {
  const page = await browser.newPage();
  await page.goto(fixture("fontface.html"));
  const fonts = await page.evaluate(resolveFonts);
  await page.close();
  expect(fonts.faces.map((f) => f.family)).toContain("Nourd Light Font");
  const urls = fontFileUrls(fonts.faces, fixture("fontface.html"));
  expect(urls.some((u) => u.endsWith("nourd-light.woff2"))).toBe(true);
});
