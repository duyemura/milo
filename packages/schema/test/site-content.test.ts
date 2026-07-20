import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GymSiteContent, SECTION_TYPES } from "../src/index.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/iron-anchor.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("GymSiteContent contract", () => {
  it("parses the canonical Iron Anchor fixture", () => {
    const parsed = GymSiteContent.parse(fixture);
    expect(parsed.brand.name).toBe("Iron Anchor");
    expect(parsed.pages.some((p) => p.slug === "home")).toBe(true);
  });

  it("the fixture exercises the entire section vocabulary", () => {
    const used = new Set(fixture.pages.flatMap((p: { sections: { type: string }[] }) => p.sections.map((s) => s.type)));
    for (const t of SECTION_TYPES) expect(used, `fixture missing section type "${t}"`).toContain(t);
    expect(used.size).toBe(SECTION_TYPES.length);
  });

  it("rejects an unknown section type (closed vocabulary)", () => {
    const bad = structuredClone(fixture);
    bad.pages[0].sections[0] = { type: "carousel-3000", heading: "nope" };
    expect(() => GymSiteContent.parse(bad)).toThrow();
  });

  it("rejects a missing brand name", () => {
    const bad = structuredClone(fixture);
    delete bad.brand.name;
    expect(() => GymSiteContent.parse(bad)).toThrow();
  });

  it("rejects a page with an unknown archetype", () => {
    const bad = structuredClone(fixture);
    bad.pages[0].archetype = "mystery-page";
    expect(() => GymSiteContent.parse(bad)).toThrow();
  });
});
