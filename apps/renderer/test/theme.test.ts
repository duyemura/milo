import { test, expect } from "vitest";
import { resolveComponent, missingSections } from "../src/lib/theme.ts";
import { manifest } from "../../../templates/modern/manifest.ts";

test("resolveComponent maps a section type to its component file", () => {
  expect(resolveComponent(manifest, "hero")).toBe("Hero.astro");
  expect(resolveComponent(manifest, "schedule")).toBe("Schedule.astro");
  expect(resolveComponent(manifest, "lead-form")).toBe("LeadForm.astro");
});

test("resolveComponent throws on an unknown section type", () => {
  expect(() => resolveComponent(manifest, "carousel-3d")).toThrow(/does not implement/);
});

test("missingSections returns empty array — manifest implements all 16 shared sections", () => {
  expect(missingSections(manifest)).toHaveLength(0);
});
