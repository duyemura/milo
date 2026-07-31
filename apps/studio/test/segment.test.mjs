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

test("descends shell wrappers instead of returning one monster block", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(fixture("nested-wrapper.html"));
  const sections = await page.evaluate(segmentPage);
  await page.close();
  expect(sections).toHaveLength(3);
  expect(sections.map((s) => s.heading)).toEqual([
    "Hero Headline",
    "Three Steps",
    "Stories of Glory",
  ]);
  // No section may span (almost) the whole page — that was the collapse bug.
  const pageHeight = 900 + 1200 + 600;
  expect(Math.max(...sections.map((s) => s.height))).toBeLessThan(pageHeight * 0.9);
});

test("keeps short header/footer siblings at the spine", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(fixture("short-header.html"));
  const sections = await page.evaluate(segmentPage);
  await page.close();
  const header = sections.find((s) => s.tag === "HEADER");
  expect(header).toBeTruthy();
  expect(header.height).toBeLessThan(80);
  expect(sections.map((s) => s.heading)).toContain("Site header");
  expect(sections.map((s) => s.heading)).toContain("Alpha");
  expect(sections.map((s) => s.heading)).toContain("Bravo");
});

test("records position and viewport-relative y for fixed elements", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(fixture("fixed-header.html"));
  const sections = await page.evaluate(segmentPage);
  await page.close();
  const header = sections.find((s) => s.tag === "HEADER");
  expect(header).toBeTruthy();
  expect(header.position).toBe("fixed");
  expect(header.y).toBeGreaterThanOrEqual(0);
});
