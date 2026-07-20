import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TemplateManifest, SECTION_TYPES } from "../src/index.ts";

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../templates");
const templateNames = readdirSync(templatesDir).filter((d) => existsSync(join(templatesDir, d, "template.json")));

describe("template manifests (documentation engine, machine half)", () => {
  it("finds at least two templates", () => {
    expect(templateNames.length).toBeGreaterThanOrEqual(2);
  });

  for (const name of templateNames) {
    describe(name, () => {
      const manifest = JSON.parse(readFileSync(join(templatesDir, name, "template.json"), "utf8"));

      it("parses as a valid TemplateManifest", () => {
        const parsed = TemplateManifest.parse(manifest);
        expect(parsed.name).toBe(name);
      });

      it("documents every section type (no doc drift)", () => {
        for (const t of SECTION_TYPES) {
          expect(manifest.components, `${name} missing docs for "${t}"`).toHaveProperty(t);
        }
      });

      it("has a component file for every documented section type", () => {
        const files = readdirSync(join(templatesDir, name, "components"));
        const pascal = (s: string) =>
          s
            .split("-")
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join("");
        for (const t of SECTION_TYPES) {
          const expected = `${pascal(t)}.astro`;
          expect(files, `${name} missing component file ${expected}`).toContain(expected);
        }
      });

      it("home archetype recipe exists and starts with hero", () => {
        expect(manifest.archetypes.home.sections[0]).toBe("hero");
      });
    });
  }
});
