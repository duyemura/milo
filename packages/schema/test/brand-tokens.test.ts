import { test, expect } from "vitest";
import { BrandTokens, tokensToCss, contrastOk } from "../src/brand-tokens.ts";

const tokens = {
  colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
  fonts: { display: "Montserrat", body: "Inter" },
  space: { sm: "8px", md: "16px", lg: "32px" },
  radius: { button: "10px", card: "12px" },
};

test("BrandTokens validates a well-formed token set", () => {
  expect(() => BrandTokens.parse(tokens)).not.toThrow();
});

test("tokensToCss emits custom properties", () => {
  const css = tokensToCss(BrandTokens.parse(tokens));
  expect(css).toContain("--color-primary: #0b1f3a;");
  expect(css).toContain("--font-display: Montserrat;");
  expect(css).toContain("--radius-button: 10px;");
  // fixed scale extensions
  expect(css).toContain("--space-xs: 4px;");
  expect(css).toContain("--space-xl: 64px;");
  expect(css).toContain("--radius-sm: 6px;");
  // semantic aliases
  expect(css).toContain("--color-on-surface: var(--color-text);");
  expect(css).toContain("--color-on-accent: var(--color-surface);");
  expect(css).toContain("--color-on-primary: var(--color-surface);");
  expect(css).toContain("--color-border: var(--color-muted);");
});

test("contrastOk flags a failing text/surface pair", () => {
  expect(contrastOk("#ffffff", "#ffffff")).toBe(false);
  expect(contrastOk("#06090a", "#ffffff")).toBe(true);
});
