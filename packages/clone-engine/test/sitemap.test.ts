import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSitemap, generateRobotsTxt } from "../src/sitemap.ts";

describe("generateSitemap", () => {
  it("produces valid XML with all page routes", () => {
    const xml = generateSitemap("https://speakeasyofstrength.com", ["/", "/about/", "/locations/"]);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("https://speakeasyofstrength.com/");
    expect(xml).toContain("https://speakeasyofstrength.com/about/");
    expect(xml).toContain("https://speakeasyofstrength.com/locations/");
  });

  it("strips trailing slash from origin before joining", () => {
    const xml = generateSitemap("https://example.com/", ["/"]);
    expect(xml).toContain("https://example.com/");
    expect(xml).not.toContain("https://example.com//");
  });

  it("writes sitemap.xml to the site dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitemap-"));
    generateSitemap("https://example.com", ["/", "/about/"], dir);
    const xml = fs.readFileSync(path.join(dir, "sitemap.xml"), "utf8");
    expect(xml).toContain("<urlset");
    expect(xml).toContain("https://example.com/about/");
  });
});

describe("generateRobotsTxt", () => {
  it("allows all crawlers and points to sitemap", () => {
    const txt = generateRobotsTxt("https://example.com");
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("writes robots.txt to the site dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robots-"));
    generateRobotsTxt("https://example.com", dir);
    const txt = fs.readFileSync(path.join(dir, "robots.txt"), "utf8");
    expect(txt).toContain("Sitemap:");
  });
});
