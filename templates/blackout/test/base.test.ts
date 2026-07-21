import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import Base from "../layouts/Base.astro";
import { tokensToCss, BrandTokens } from "@milo/schema";

const tokens = BrandTokens.parse({
  colors: { primary: "#0b1220", accent: "#0464fc", surface: "#ffffff", text: "#06090a", muted: "#5b6470" },
  fonts: { display: "Oswald", body: "system-ui" },
  space: { sm: "8px", md: "16px", lg: "32px" }, radius: { button: "0px", card: "0px" },
});

const headSlot = [
  '<title>Iron Anchor — Denver</title>',
  '<meta name="description" content="Dark gym. Coached CrossFit.">',
  '<link rel="canonical" href="https://example.com/">',
].join("");

test("Base renders head slot content and injects token CSS vars", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Base, {
    props: { tokenCss: tokensToCss(tokens) },
    slots: { head: headSlot, default: "<main>hi</main>" },
  });
  expect(html).toContain("<title>Iron Anchor — Denver</title>");
  expect(html).toMatch(/<meta name="description" content="Dark gym\. Coached CrossFit\."/);
  expect(html).toMatch(/<link rel="canonical" href="https:\/\/example\.com\/"/);
  expect(html).toContain("--color-accent: #0464fc;");
  expect(html).toContain("<main>hi</main>");
});
