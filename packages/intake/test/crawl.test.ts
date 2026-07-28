import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripBoilerplate, extractPageDocument, collectAssetUrls, needsPlaywright, metaContent, sanitizeAssetName } from "../src/crawl.ts";

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

  it("collects og:image even when content precedes property (CMS order)", () => {
    const html = `<html><head><meta content="/og.png" property="og:image"></head></html>`;
    expect(collectAssetUrls(html, "https://g.com/about")).toContain("https://g.com/og.png");
  });
});

describe("metaContent (attribute-order independent)", () => {
  it("reads description when content comes before name", () => {
    const html = `<meta content="A great gym." name="description">`;
    expect(metaContent(html, "name", "description")).toBe("A great gym.");
  });
  it("returns empty string when the meta tag is absent", () => {
    expect(metaContent(`<meta name="keywords" content="x">`, "name", "description")).toBe("");
  });
});

describe("extractPageDocument metaDescription", () => {
  it("reads content-first description order", () => {
    const doc = extractPageDocument({
      html: `<html><head><title>T</title><meta content="Desc here" name="description"></head><body><main>hello world this is body text that is long enough to matter for extraction.</main></body></html>`,
      url: "https://g.com/x", slug: "x", baseUrl: "https://g.com/", fetchMethod: "static", llmBudget: "full",
    });
    expect(doc.metaDescription).toBe("Desc here");
  });
});

describe("sanitizeAssetName", () => {
  it("gives distinct names to same-basename assets on different paths", () => {
    const a = sanitizeAssetName("https://g.com/en/hero.jpg");
    const b = sanitizeAssetName("https://g.com/fr/hero.jpg");
    expect(a).not.toBe(b);
    expect(a.endsWith("hero.jpg")).toBe(true);
    expect(b.endsWith("hero.jpg")).toBe(true);
  });
});
