import { test, expect } from "vitest";
import { resolveComponent, missingSections } from "../src/lib/theme.ts";
import { SECTION_TYPES } from "@milo/schema";
import * as modernRegistry from "../../../templates/modern/registry.ts";
import * as blackoutRegistry from "../../../templates/blackout/registry.ts";
import { manifest } from "../../../templates/modern/manifest.ts";
import { manifest as blackoutManifest } from "../../../templates/blackout/manifest.ts";

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

test("modern registry.COMPONENTS implements exactly all 16 SECTION_TYPES", () => {
  const keys = Object.keys(modernRegistry.COMPONENTS).sort();
  const expected = [...SECTION_TYPES].sort();
  expect(keys).toEqual(expected);
});

test("blackout registry.COMPONENTS implements exactly all 16 SECTION_TYPES", () => {
  const keys = Object.keys(blackoutRegistry.COMPONENTS).sort();
  const expected = [...SECTION_TYPES].sort();
  expect(keys).toEqual(expected);
});

test("modern manifest.implements keys match SECTION_TYPES", () => {
  const keys = Object.keys(manifest.implements).sort();
  const expected = [...SECTION_TYPES].sort();
  expect(keys).toEqual(expected);
});

test("blackout manifest.implements keys match SECTION_TYPES", () => {
  const keys = Object.keys(blackoutManifest.implements).sort();
  const expected = [...SECTION_TYPES].sort();
  expect(keys).toEqual(expected);
});

test("missingSections returns [] for blackout manifest", () => {
  expect(missingSections(blackoutManifest)).toHaveLength(0);
});
