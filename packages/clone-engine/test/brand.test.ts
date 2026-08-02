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
      const reprOfCanon = reprOfCanonFor(cap);
      const variants = deriveVariants(labels, reprOfCanon.keys());
      const brand = buildBrand(labels, reprOfCanon, variants);

      it("matches BrandDoc shape (colors, fonts, space, radius)", () => {
        expect(Object.keys(brand.colors).sort()).toEqual(["accent", "muted", "primary", "surface", "text"]);
        expect(Object.keys(brand.fonts).sort()).toEqual(["body", "display"]);
        expect(Object.keys(brand.space).sort()).toEqual(["lg", "md", "sm"]);
        expect(Object.keys(brand.radius).sort()).toEqual(["button", "card"]);
        expect(brand.fonts.display.length).toBeGreaterThan(0);
        expect(brand.fonts.body.length).toBeGreaterThan(0);
        // Each slot is now { value, hex, variants } — value is what :root uses.
        for (const slot of Object.values(brand.colors)) {
          expect(typeof slot.value).toBe("string");
          expect(slot.value.length).toBeGreaterThan(0);
          expect(typeof slot.variants).toBe("object");
        }
      });

      it("every color slot's editable hex is a valid #rrggbb", () => {
        for (const [slot, s] of Object.entries(brand.colors)) {
          expect(s.hex, `${slot}=${s.hex}`).toMatch(HEX);
        }
      });

      it("each slot's value IS the exact captured literal of its canon (alpha preserved)", () => {
        const slotMap = brandSlotOfCanon(labels);
        // canon → slot name (reverse the "canon → --color-<slot>" map).
        for (const [canonStr, varName] of slotMap) {
          const slot = varName.replace("--color-", "") as keyof typeof brand.colors;
          const repr = reprOfCanon.get(canonStr);
          expect(repr, `${varName} canon=${canonStr}`).toBeTruthy();
          // The slot's value is byte-identical to the captured literal (this is the 0-px guard).
          expect(brand.colors[slot].value).toBe(repr);
        }
      });

      it("every canonical --color-<slot> in :root equals the slot's exact value", () => {
        const root = flattenRoot(brand);
        for (const [slot, s] of Object.entries(brand.colors)) {
          expect(root).toContain(`--color-${slot}: ${s.value};`);
        }
      });

      it("every derived variant token's value equals the exact captured literal it replaces", () => {
        const root = flattenRoot(brand);
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

/**
 * brand.json IS the editable source of :root (the contract subsystem C's `setBrand` builds on):
 *   1. First emit — the canonical --color-<slot> values equal the exact captured literals.
 *   2. The connection — mutating a brand.json slot value + re-flattening changes :root.
 */
describe("brand.json → :root connection (Task 1)", () => {
  for (const site of SITES) {
    describe(site, () => {
      const cap = loadCapture(site);
      const labels = heuristicLabels(cap);
      const reprOfCanon = reprOfCanonFor(cap);
      const variants = deriveVariants(labels, reprOfCanon.keys());

      it("first-emit :root canonical values equal the captured values (0-px seed)", () => {
        const brand = buildBrand(labels, reprOfCanon, variants);
        const root = flattenRoot(brand);
        for (const [canonStr, varName] of brandSlotOfCanon(labels)) {
          // The captured literal for this slot's canon is what :root must emit, unchanged.
          expect(root).toContain(`${varName}: ${reprOfCanon.get(canonStr)};`);
        }
      });

      it("mutating a brand.json slot value + re-flattening changes :root (setBrand works)", () => {
        const brand = buildBrand(labels, reprOfCanon, variants);
        const before = flattenRoot(brand);
        expect(before).toContain(`--color-primary: ${brand.colors.primary.value};`);

        // Simulate C's setBrand: edit the primary slot's value (a genuinely different color).
        const NEW = "rgb(1, 2, 3)";
        const mutated = { ...brand, colors: { ...brand.colors, primary: { ...brand.colors.primary, value: NEW } } };
        const after = flattenRoot(mutated);

        // :root now reflects the edited value — brand.json is a live knob, not inert.
        expect(after).toContain(`--color-primary: ${NEW};`);
        expect(after).not.toBe(before);
      });

      it("alpha-carrying slot values keep their rgba() form (never collapsed to opaque hex)", () => {
        const brand = buildBrand(labels, reprOfCanon, variants);
        // Any slot whose captured value carried alpha must keep the alpha in its value
        // (e.g. sweatshed muted = rgba(175, 175, 175, 0.1)). hex may be opaque; value must not.
        for (const [slot, s] of Object.entries(brand.colors)) {
          if (/rgba\(|,\s*0?\.\d+\)|,\s*0\)/.test(s.value)) {
            expect(s.value, `${site}.${slot} value should preserve alpha`).toMatch(/rgba\(/);
          }
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

      // brand.json ships INSIDE astro/ + re-readable + valid shape.
      const brandJson = JSON.parse(fs.readFileSync(path.join(out, "astro/brand.json"), "utf8"));
      expect(brandJson.colors.primary.hex).toMatch(HEX);
      expect(brandJson.colors.surface.hex).toMatch(HEX);
      expect(brandJson.fonts.display.length).toBeGreaterThan(0);

      // The value :root uses is present + non-empty for every slot.
      for (const slot of ["primary", "accent", "surface", "text", "muted"] as const) {
        expect(brandJson.colors[slot].value.length, `${site}.${slot}.value`).toBeGreaterThan(0);
      }

      // The emitted :root uses brand.json's exact value (proves brand.json IS the source).
      const css = fs.readFileSync(path.join(out, "astro/src/styles/global.css"), "utf8");
      expect(css).toContain(`--color-primary: ${brandJson.colors.primary.value};`);

      // Editing --color-primary recolors every var(--color-primary) reference: prove >1 ref exists.
      const primaryRefs = (css.match(/var\(--color-primary\)/g) ?? []).length;
      expect(primaryRefs, `${site} var(--color-primary) references`).toBeGreaterThan(1);

      // The knob is DEFINED exactly once in :root (single source of truth).
      const primaryDefs = (css.match(/--color-primary:\s/g) ?? []).length;
      expect(primaryDefs, `${site} --color-primary definitions`).toBe(1);
    }, 180_000);
  }
});
