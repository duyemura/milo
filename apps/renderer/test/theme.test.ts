import { test, expect } from "vitest";
import { resolveComponent, missingSections } from "../src/lib/theme.ts";
import { manifest } from "../../../templates/modern/manifest.ts";

test("resolveComponent maps a section type to its component file", () => {
  expect(resolveComponent(manifest, "hero")).toBe("Hero.astro");
});

test("resolveComponent throws on a section the theme does not implement", () => {
  expect(() => resolveComponent(manifest, "schedule")).toThrow(/does not implement/);
});

test("missingSections lists shared sections not yet implemented", () => {
  // skeleton implements 3; the shared vocabulary is larger
  expect(missingSections(manifest)).toContain("schedule");
});
