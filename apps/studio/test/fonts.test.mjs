import { test, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveFonts, fontFileUrls, parseFontFacesFromCss, resolveFontFileUrlsDeep } from "../src/fonts.mjs";

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

test("parseFontFacesFromCss extracts faces from raw stylesheet text", () => {
  const css = `
    /* comment with @font-face should be ignored */
    @font-face {
      font-family: "Nourd Light Font";
      font-style: normal;
      font-weight: 300;
      src: url("/fonts/nourd-light.woff2") format("woff2");
    }
    @font-face {
      font-family: Custom Body;
      src: url("/fonts/body.woff2") format("woff2"), url("/fonts/body.woff") format("woff");
    }
  `;
  const faces = parseFontFacesFromCss(css);
  const families = faces.map((f) => f.family);
  expect(families).toContain("Nourd Light Font");
  expect(families).toContain("Custom Body");
  const body = faces.find((f) => f.family === "Custom Body");
  expect(body.src).toContain("body.woff2");
  expect(body.src).toContain("body.woff");
});

test("resolveFontFileUrlsDeep fetches linked stylesheets and resolves font URLs", async () => {
  const page = await browser.newPage();
  await page.goto(fixture("cross-origin-fontface.html"));
  const info = await resolveFontFileUrlsDeep(page, fixture("cross-origin-fontface.html"));
  await page.close();
  expect(info.faces.map((f) => f.family)).toContain("Nourd Light Font");
  expect(info.urls.some((u) => u.endsWith("nourd-light.woff2"))).toBe(true);
});
