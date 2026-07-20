import { test, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { segmentPage } from "../src/segment.mjs";

const fixture = (name) =>
  "file://" + path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

let browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

test("segments three top-level sections in order", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(fixture("three-sections.html"));
  const sections = await page.evaluate(segmentPage);
  await page.close();
  expect(sections).toHaveLength(3);
  expect(sections.map((s) => s.heading)).toEqual(["Alpha", "Bravo", "Charlie"]);
});
