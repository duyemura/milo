import { describe, it, expect } from "vitest";
import { generatePageMeta, injectPageMeta } from "../../src/edit/seo-meta.ts";

describe("generatePageMeta", () => {
  it("derives a title and description from a brief and route", () => {
    const meta = generatePageMeta("/about/", "About us page for Speakeasy of Strength gym in Brooklyn NY", "Speakeasy of Strength");
    expect(meta.title.length).toBeGreaterThan(0);
    expect(meta.title.length).toBeLessThanOrEqual(60);
    expect(meta.description.length).toBeGreaterThan(0);
    expect(meta.description.length).toBeLessThanOrEqual(155);
    expect(meta.canonical).toBe("/about/");
  });

  it("uses route slug as fallback when no brief is provided", () => {
    const meta = generatePageMeta("/about/", "", "MySite");
    expect(meta.title).toContain("About");
  });
});

describe("injectPageMeta", () => {
  it("replaces placeholder title and adds meta description", () => {
    const html = `<!doctype html><html><head><title>About | Clone</title></head><body></body></html>`;
    const result = injectPageMeta(html, { title: "About Us | Speakeasy", description: "Learn about Speakeasy of Strength.", canonical: "/about/" });
    expect(result).toContain("<title>About Us | Speakeasy</title>");
    expect(result).toContain('name="description" content="Learn about Speakeasy of Strength."');
    expect(result).toContain('rel="canonical"');
  });

  it("is idempotent — does not duplicate meta on second call", () => {
    const html = `<html><head><title>T</title></head><body></body></html>`;
    const once = injectPageMeta(html, { title: "T", description: "D", canonical: "/" });
    const twice = injectPageMeta(once, { title: "T", description: "D", canonical: "/" });
    expect(twice.split('name="description"').length - 1).toBe(1);
  });
});
