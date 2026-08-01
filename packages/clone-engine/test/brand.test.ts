/**
 * brand.test.ts — global brand document (`brand.json`) + canonical token cascade (Plan 2, Task 3).
 *
 * Guards the byte-preserving brand cascade (the pixel oracle in parity-project.test.ts is the
 * hard fidelity gate; these assert the *structure* that makes it safe):
 *   - buildBrand output matches the BrandDoc / BrandTokens shape; every color slot is a valid hex.
 *   - a derived variant token's value equals the EXACT captured literal it replaced.
 *   - editing `--color-primary` in the emitted :root would recolor all `var(--color-primary)` refs
 *     (the brand primary is referenced more than once — proves the cascade is a single knob).
 *   - brand.json is written to OUT and re-readable.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { heuristicLabels } from "../src/labels.ts";
import { buildBrand, brandSlotOfCanon, deriveVariants, flattenRoot, canon } from "../src/brand.ts";
import { project } from "../src/project.ts";
import type { CaptureJson } from "../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["torrance", "speakeasy", "sweatshed"] as const;
const HEX = /^#[0-9a-f]{6}$/;
const COLOR_RE = /rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;

function loadCapture(site: string): CaptureJson {
  return JSON.parse(fs.readFileSync(path.join(dir, "golden", site, "capture.json"), "utf8")) as CaptureJson;
}

/** All distinct canonical colors + their exact captured repr across every width. */
function reprOfCanonFor(cap: CaptureJson): Map<string, string> {
  const m = new Map<string, string>();
  for (const w of ["1440", "768", "390"]) {
    const S = cap.styles[w] ?? {};
    for (const id in S) for (const v of Object.values(S[id])) {
      for (const lit of String(v).matchAll(COLOR_RE)) {
        const k = canon(lit[0]);
        if (!m.has(k)) m.set(k, lit[0]);
      }
    }
  }
  return m;
}

describe("buildBrand + canonical cascade", () => {
  for (const site of SITES) {
    describe(site, () => {
      const cap = loadCapture(site);
      const labels = heuristicLabels(cap);
      const brand = buildBrand(labels, cap);
      const reprOfCanon = reprOfCanonFor(cap);

      it("matches BrandDoc shape (colors, fonts, space, radius)", () => {
        expect(Object.keys(brand.colors).sort()).toEqual(["accent", "muted", "primary", "surface", "text"]);
        expect(Object.keys(brand.fonts).sort()).toEqual(["body", "display"]);
        expect(Object.keys(brand.space).sort()).toEqual(["lg", "md", "sm"]);
        expect(Object.keys(brand.radius).sort()).toEqual(["button", "card"]);
        expect(brand.fonts.display.length).toBeGreaterThan(0);
        expect(brand.fonts.body.length).toBeGreaterThan(0);
      });

      it("every color slot resolves to a valid #rrggbb hex", () => {
        for (const [slot, value] of Object.entries(brand.colors)) {
          expect(value, `${slot}=${value}`).toMatch(HEX);
        }
      });

      it("every canonical --color-<slot> in :root equals the exact captured literal of its slot canon", () => {
        const variants = deriveVariants(labels, reprOfCanon.keys());
        const root = flattenRoot(labels, brand, variants, reprOfCanon);
        const slotMap = brandSlotOfCanon(labels);
        for (const [canonStr, varName] of slotMap) {
          const repr = reprOfCanon.get(canonStr);
          // The labeler only assigns slots from colors actually present, so a repr must exist.
          expect(repr, `${varName} canon=${canonStr}`).toBeTruthy();
          expect(root).toContain(`${varName}: ${repr};`);
        }
      });

      it("every derived variant token's value equals the exact captured literal it replaces", () => {
        const variants = deriveVariants(labels, reprOfCanon.keys());
        const root = flattenRoot(labels, brand, variants, reprOfCanon);
        for (const [canonStr, varName] of variants) {
          const repr = reprOfCanon.get(canonStr);
          expect(repr, `${varName} canon=${canonStr}`).toBeTruthy();
          // byte-exact: the emitted var value IS the captured literal (no re-serialization)
          expect(root).toContain(`${varName}: ${repr};`);
        }
      });

      it("brandSlotOfCanon maps only canons that appear byte-exact in the styles (byte-preserving)", () => {
        const slotMap = brandSlotOfCanon(labels);
        for (const canonStr of slotMap.keys()) {
          // Every mapped slot canon must have a captured literal — otherwise rewriting a
          // literal to var(--color-<slot>) could not be proven byte-identical.
          expect(reprOfCanon.has(canonStr), `slot canon ${canonStr} not in captured styles`).toBe(true);
        }
      });
    });
  }
});

describe("emitted project: brand.json + recolor knob", () => {
  const outDirs: string[] = [];
  afterAll(() => { for (const d of outDirs) fs.rmSync(d, { recursive: true, force: true }); });

  for (const site of SITES) {
    it(`${site}: writes a re-readable brand.json + brand primary is a single recolor knob`, async () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "brand-test-"));
      outDirs.push(out);
      await project({ dir: path.join(dir, "golden", site), out, trim: true, noDiff: true });

      // brand.json written + re-readable + valid shape
      const brandJson = JSON.parse(fs.readFileSync(path.join(out, "brand.json"), "utf8"));
      expect(brandJson.colors.primary).toMatch(HEX);
      expect(brandJson.colors.surface).toMatch(HEX);
      expect(brandJson.fonts.display.length).toBeGreaterThan(0);

      // Editing --color-primary recolors every var(--color-primary) reference: prove >1 ref exists.
      const css = fs.readFileSync(path.join(out, "astro/src/styles/global.css"), "utf8");
      const primaryRefs = (css.match(/var\(--color-primary\)/g) ?? []).length;
      expect(primaryRefs, `${site} var(--color-primary) references`).toBeGreaterThan(1);

      // The knob is DEFINED exactly once in :root (single source of truth).
      const primaryDefs = (css.match(/--color-primary:\s/g) ?? []).length;
      expect(primaryDefs, `${site} --color-primary definitions`).toBe(1);
    }, 180_000);
  }
});
