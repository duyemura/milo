import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Pricing from "../components/Pricing.astro";

const src = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/Pricing.astro"),
  "utf8",
);
const styleBlock = src.slice(src.indexOf("<style"));

test("Pricing renders plan names, prices, and features", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(Pricing, {
    props: {
      heading: "Membership options",
      plans: [
        { name: "Drop-in", price: "$25", features: ["Single class"], featured: false },
        { name: "Unlimited", price: "$150", period: "/mo", features: ["Unlimited classes", "Open gym access"], cta: { label: "Join now", href: "/join" }, featured: true },
      ],
    },
  });
  expect(html).toContain("Drop-in");
  expect(html).toContain("$25");
  expect(html).toContain("Unlimited");
  expect(html).toContain("$150");
  expect(html).toContain("Unlimited classes");
  expect(html).toContain("Join now");
  expect(styleBlock).toMatch(/var\(--color-/);
  expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleBlock).not.toMatch(/\brgba?\s*\(/);
  expect(styleBlock).not.toMatch(/\bhsla?\s*\(/);
});
