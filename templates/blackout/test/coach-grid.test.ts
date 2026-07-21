import { test, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import CoachGrid from "../components/CoachGrid.astro";

const componentSrc = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/CoachGrid.astro"),
  "utf8",
);
const styleSrc = componentSrc.slice(componentSrc.indexOf("<style"));

test("CoachGrid renders coach names and roles", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(CoachGrid, {
    props: {
      heading: "Meet the coaches",
      coaches: [
        { name: "Jane Smith", role: "Head Coach", bio: "10 years CrossFit.", certs: ["CF-L3"] },
        { name: "Bob Lee", role: "Coach", photo: "assets/bob.webp" },
      ],
    },
  });
  expect(html).toContain("Jane Smith");
  expect(html).toContain("Bob Lee");
  // Person JSON-LD is emitted by the renderer @graph, not this component
  expect(html).not.toContain('"Person"');
  // token check — read from source since Astro container strips <style> in SSR
  expect(styleSrc).toMatch(/var\(--color-/);
  expect(styleSrc).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(styleSrc).not.toMatch(/\brgba?\s*\(/);
  expect(styleSrc).not.toMatch(/\bhsla?\s*\(/);
});

test("CoachGrid renders photo img when provided, avatar initials when not", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(CoachGrid, {
    props: {
      coaches: [
        { name: "Alice Brown", photo: "assets/alice.webp", certs: [] },
        { name: "Tom Chen", certs: [] },
      ],
    },
  });
  // Alice has a photo — expect an img with her name as alt
  expect(html).toContain('alt="Alice Brown"');
  expect(html).toContain("assets/alice.webp");
  // Tom has no photo — expect initials avatar
  expect(html).toContain("TC");
});

test("CoachGrid renders heading when provided", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(CoachGrid, {
    props: {
      heading: "Our Coaches",
      coaches: [{ name: "Solo Coach", certs: [] }],
    },
  });
  expect(html).toContain("Our Coaches");
});

test("CoachGrid renders certs when provided", async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(CoachGrid, {
    props: {
      coaches: [{ name: "Cert Coach", certs: ["CF-L3", "CPR"] }],
    },
  });
  expect(html).toContain("CF-L3");
  expect(html).toContain("CPR");
});
