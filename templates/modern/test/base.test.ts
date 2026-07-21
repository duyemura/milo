import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Base from "../layouts/Base.astro";
import { tokensToCss, BrandTokens } from "@milo/schema";

const tokens = BrandTokens.parse({
  colors: { primary: "#0b1f3a", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
  fonts: { display: "Montserrat", body: "Inter" },
  space: { sm: "8px", md: "16px", lg: "32px" }, radius: { button: "10px", card: "12px" },
});

test("Base renders head SEO tags and injects token CSS vars", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Base, {
    props: { title: "Iron Anchor — Denver", description: "Coached CrossFit.", canonical: "https://example.com/", tokenCss: tokensToCss(tokens) },
    slots: { default: "<main>hi</main>" },
  });
  expect(html).toContain("<title>Iron Anchor — Denver</title>");
  expect(html).toMatch(/<meta name="description" content="Coached CrossFit\."/);
  expect(html).toMatch(/<link rel="canonical" href="https:\/\/example\.com\/"/);
  expect(html).toContain("--color-accent: #0464fc;");
  expect(html).toContain("<main>hi</main>");
});
