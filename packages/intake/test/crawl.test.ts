import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripBoilerplate, extractPageDocument, collectAssetUrls, needsPlaywright } from "../src/crawl.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const about = readFileSync(path.join(dir, "fixtures/about.html"), "utf8");
const jsRendered = readFileSync(path.join(dir, "fixtures/js-rendered.html"), "utf8");

describe("stripBoilerplate", () => {
  it("removes nav, header, footer, script, style", () => {
    const text = stripBoilerplate(about);
    expect(text).not.toMatch(/ignore me/);
    expect(text).not.toMatch(/analytics/);
    expect(text).toMatch(/Iron Anchor opened in 2015/);
  });
});

describe("needsPlaywright", () => {
  it("is true when stripped body text is under 200 chars", () => {
    expect(needsPlaywright(jsRendered)).toBe(true);
    expect(needsPlaywright(about)).toBe(false);
  });
});

describe("extractPageDocument", () => {
  it("builds a PageDocument from static HTML", () => {
    const doc = extractPageDocument({
      html: about, url: "https://ironanchor.com/about", slug: "about",
      baseUrl: "https://ironanchor.com/", fetchMethod: "static", llmBudget: "full",
    });
    expect(doc.title).toBe("About Iron Anchor");
    expect(doc.metaDescription).toBe("Our story and mission.");
    expect(doc.headings).toContain("Our Story");
    expect(doc.images[0].src).toContain("/img/coach.jpg");
    expect(doc.links).toContain("https://ironanchor.com/coaches");
    expect(doc.bodyText).toMatch(/2015/);
  });

  it("truncates bodyText to 800 chars for truncated budget", () => {
    const long = `<html><body><main>${"x".repeat(2000)}</main></body></html>`;
    const doc = extractPageDocument({
      html: long, url: "https://g.com/p", slug: "p", baseUrl: "https://g.com/",
      fetchMethod: "static", llmBudget: "truncated",
    });
    expect(doc.bodyText.length).toBe(800);
  });
});

describe("collectAssetUrls", () => {
  it("collects img src and og:image, absolute-resolved", () => {
    const html = `<html><head><meta property="og:image" content="/og.png"></head>
      <body><img src="hero.webp"></body></html>`;
    const urls = collectAssetUrls(html, "https://g.com/about");
    expect(urls).toContain("https://g.com/og.png");
    expect(urls).toContain("https://g.com/hero.webp");
  });
});
