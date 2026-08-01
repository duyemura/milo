/**
 * labels.test.ts — heuristic labeler smoke + determinism + schema-validity tests.
 *
 * Three assertions per golden site:
 * 1. LabelSchema.parse() doesn't throw  (schema validity)
 * 2. Two calls produce deep-equal output  (determinism)
 * 3. Sanity: brand.colors has primary + surface; sections.length > 0; headline element present
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { heuristicLabels, LabelSchema } from "../src/labels.ts";
import type { CaptureJson } from "../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["torrance", "speakeasy", "sweatshed"] as const;

function loadCapture(site: string): CaptureJson {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "golden", site, "capture.json"), "utf8"),
  ) as CaptureJson;
}

describe("heuristicLabels", () => {
  for (const site of SITES) {
    describe(site, () => {
      const cap = loadCapture(site);
      const labels = heuristicLabels(cap);

      it("validates against LabelSchema", () => {
        expect(() => LabelSchema.parse(labels)).not.toThrow();
      });

      it("is deterministic (two calls deep-equal)", () => {
        expect(heuristicLabels(cap)).toEqual(heuristicLabels(cap));
      });

      it("sanity: has primary color, surface color, sections, and headline element", () => {
        // brand.colors includes primary
        const colorSlots = labels.brand.colors.map((c) => c.slot);
        expect(colorSlots).toContain("primary");
        // brand.colors includes surface
        expect(colorSlots).toContain("surface");
        // at least one section
        expect(labels.sections.length).toBeGreaterThan(0);
        // all section roles are valid
        const validRoles = new Set([
          "hero", "faq", "program-cards", "coach-grid", "testimonials", "pricing",
          "cta-band", "feature-grid", "location-map", "schedule", "stats-band",
          "logo-strip", "media-block", "content-block", "contact-form", "lead-form", "unknown",
        ]);
        for (const sec of labels.sections) {
          expect(validRoles).toContain(sec.role);
        }
        // headline element present
        const elementRoles = labels.elements.map((e) => e.role);
        expect(elementRoles).toContain("headline");
        // site.name is non-empty
        expect(labels.site.name.length).toBeGreaterThan(0);
      });
    });
  }
});
