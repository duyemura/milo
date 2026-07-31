import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractColors, extractFonts, extractLogo, extractSocialLinks, fingerprintSoftware, detectAnalytics } from "../src/brand.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "fixtures/brand.html"), "utf8");

describe("brand extraction", () => {
  it("counts hex colors by frequency", () => {
    const colors = extractColors(html);
    expect(colors["#0b1f3a"]).toBeGreaterThanOrEqual(1);
    expect(colors["#ffffff"]).toBeGreaterThanOrEqual(1);
  });
  it("maps display + body font slots from CSS variables", () => {
    const fonts = extractFonts(html);
    expect(fonts.display).toBe("Oswald");
    expect(fonts.body).toBe("Inter");
  });
  it("finds the header logo", () => {
    expect(extractLogo(html, "https://g.com/")).toBe("https://g.com/logo.svg");
  });
  it("extracts social links", () => {
    const s = extractSocialLinks(html);
    expect(s).toContain("https://instagram.com/ironanchor");
    expect(s).toContain("https://facebook.com/ironanchor");
  });
  it("fingerprints gym software", () => {
    expect(fingerprintSoftware(html)).toBe("PushPress");
  });
  it("detects analytics ids", () => {
    const a = detectAnalytics(html);
    expect(a.gtm).toBe("GTM-ABC123");
    expect(a.facebookPixel).toBe("detected");   // pixel present, id parsed separately if available
  });
  it("body font-family lookup is not hijacked by a tbody rule", () => {
    const css = `<style>tbody { font-family: Comic Sans; } body { font-family: Helvetica; }</style>`;
    expect(extractFonts(css).body).toBe("Helvetica");
  });
  it("prefers Playwright computed fonts over CSS regex", () => {
    const css = `<style>:root{--font-heading:"Oswald";--font-body:"Inter";}</style>`;
    const computed = { display: "Anton", body: "Roboto" };
    const fonts = extractFonts(css, computed);
    expect(fonts.display).toBe("Anton");
    expect(fonts.body).toBe("Roboto");
  });
  it("falls back through CSS variables, tag rules, and finally Inter", () => {
    expect(extractFonts("<html><body><h1>Hi</h1>").display).toBe("Inter");
    expect(extractFonts("<html><body><h1>Hi</h1>").body).toBe("Inter");
    const withVars = `<style>:root{--font-heading:"Bebas Neue";--font-body:"Open Sans";}</style>`;
    expect(extractFonts(withVars).display).toBe("Bebas Neue");
    expect(extractFonts(withVars).body).toBe("Open Sans");
  });
});
