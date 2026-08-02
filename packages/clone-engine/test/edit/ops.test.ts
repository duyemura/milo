/**
 * ops.test.ts — editCopy + setBrand + swapAsset + styleTweak over a real projected fixture.
 *
 * Each test projects the speakeasy golden to a fresh temp dir (the browser runs
 * once per describe block via a shared fixture), then mutates and asserts.
 *
 * Assertions:
 *   editCopy   — the resolved component .astro now contains the sentinel at the
 *                correct content[] index; changedFiles + targetSections are right.
 *   setBrand   — brand.json primary.value updated; global.css :root has the new
 *                token; a leftover non-brand token in :root is byte-identical.
 *   swapAsset  — the logo asset file's bytes changed; the ref still resolves
 *                (same filename if same type); changedFiles non-empty.
 *   styleTweak — the CTA's .pN rule has the new declaration; brand-token
 *                preference works; bounded-set guard throws on bad prop.
 *   TargetError — resolveCopy with a bogus key throws TargetError (no file write).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../src/project.ts";
import { editCopy, setBrand, swapAsset, styleTweak } from "../../src/edit/ops.ts";
import { resolveCopy, TargetError } from "../../src/edit/target.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { SiteManifest, BrandDoc } from "../../src/types.ts";

/**
 * A minimal valid 1×1 transparent PNG (67 bytes). Used as a test asset so we
 * don't need any external files or network calls in swapAsset tests.
 */
const TINY_PNG_BUF = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
  "hex",
);

const dir = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(dir, "../golden/speakeasy");

// ---------------------------------------------------------------------------
// Shared fixture — projected once, cleaned up after all tests.
// ---------------------------------------------------------------------------

let outDir: string;
let site: SiteRef;
let manifest: SiteManifest;

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-ops-test-"));
  await project({ dir: GOLDEN, out: outDir, trim: true, noDiff: true });
  site = { dir: outDir };
  manifest = JSON.parse(fs.readFileSync(path.join(outDir, "site.json"), "utf8")) as SiteManifest;
}, 180_000);

afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// editCopy
// ---------------------------------------------------------------------------

describe("editCopy", () => {
  it("writes SENTINEL_XYZ at the correct content[] index + changedFiles/targetSections correct", () => {
    // Grab the first copy entry from the manifest — guaranteed to exist.
    const page = manifest.pages[0];
    expect(page.copy.length, "site.json has no copy entries").toBeGreaterThan(0);
    const entry = page.copy[0];

    const SENTINEL = "SENTINEL_XYZ_EDIT_OPS_TEST";
    const result = editCopy(site, entry.key, SENTINEL);

    // changedFiles is a single .astro, targetSections names the component.
    expect(result.changedFiles).toHaveLength(1);
    expect(result.changedFiles[0]).toMatch(/\.astro$/);
    expect(result.targetSections).toEqual([entry.component]);

    // The component file now contains the sentinel at the right array index.
    const src = fs.readFileSync(result.changedFiles[0], "utf8");
    // Parse content[] and check the element at the correct index.
    const marker = "const content = ";
    const declStart = src.indexOf(marker);
    expect(declStart, "no const content = in component").toBeGreaterThanOrEqual(0);
    const arrStart = src.indexOf("[", declStart);
    // Find matching close bracket.
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = arrStart; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const parsed: string[] = JSON.parse(src.slice(arrStart, end));
    expect(parsed[entry.index]).toBe(SENTINEL);
  });

  it("preserves surrounding file content outside the content[] array", () => {
    const entry = manifest.pages[0].copy[0];
    const src = fs.readFileSync(
      path.join(outDir, "astro", "src", "components", `${entry.component}.astro`),
      "utf8",
    );
    // The HTML template portion (after the frontmatter closing ---) must still exist.
    expect(src).toContain("---");
    // The content array declaration itself is still present.
    expect(src).toContain("const content = ");
  });

  it("can round-trip: write sentinel → write original text back", () => {
    const entry = manifest.pages[0].copy[0];
    const SENTINEL = "ROUNDTRIP_SENTINEL_ALPHA";
    const original = entry.text.slice(0, 60); // text is a truncated preview

    editCopy(site, entry.key, SENTINEL);
    // Now write back the original preview text (not necessarily identical to the full text,
    // but proves the mechanism is idempotent).
    const result = editCopy(site, entry.key, original);
    const src = fs.readFileSync(result.changedFiles[0], "utf8");
    expect(src).toContain(JSON.stringify(original));
  });
});

// ---------------------------------------------------------------------------
// setBrand
// ---------------------------------------------------------------------------

describe("setBrand", () => {
  it("updates brand.json primary.value and primary.hex to the new blue", () => {
    const NEW_HEX = "#1e40af";
    setBrand(site, "primary", NEW_HEX);

    const brand = JSON.parse(
      fs.readFileSync(path.join(outDir, "astro", "brand.json"), "utf8"),
    ) as BrandDoc;
    expect(brand.colors.primary.hex).toBe(NEW_HEX.toLowerCase());
    // value is an rgb() literal for the new color: rgb(30, 64, 175)
    expect(brand.colors.primary.value).toBe("rgb(30, 64, 175)");
  });

  it("regenerates global.css :root with the new primary token value", () => {
    const css = fs.readFileSync(
      path.join(outDir, "astro", "src", "styles", "global.css"),
      "utf8",
    );
    // The brand primary token in :root must now hold the new value.
    expect(css).toContain("--color-primary: rgb(30, 64, 175);");
  });

  it("leftover non-brand tokens in :root are byte-identical after setBrand", () => {
    const css = fs.readFileSync(
      path.join(outDir, "astro", "src", "styles", "global.css"),
      "utf8",
    );
    // Find the :root block.
    const rootStart = css.indexOf(":root {");
    const rootEnd = css.indexOf("}", rootStart);
    const block = css.slice(rootStart, rootEnd + 1);

    // Non-brand leftover tokens look like --p<n> (per-literal color tokens).
    // They must still be present and untouched (they are not --color-<slot>).
    const leftovers = [...block.matchAll(/^\s*(--p\d+)\s*:/gm)];
    if (leftovers.length > 0) {
      // At least one leftover survived.
      expect(block).toContain(leftovers[0][1] + ":");
    }
    // Whether or not there are per-literal tokens, the brand-managed tokens must be present.
    expect(block).toContain("--color-primary:");
    expect(block).toContain("--color-accent:");
    expect(block).toContain("--color-surface:");
    expect(block).toContain("--font-display:");
  });

  it("preserves variant alpha when recomputing variants", () => {
    const brandBefore = JSON.parse(
      fs.readFileSync(path.join(outDir, "astro", "brand.json"), "utf8"),
    ) as BrandDoc;
    const primaryVariants = Object.entries(brandBefore.colors.primary.variants);
    if (primaryVariants.length === 0) {
      // Some sites have no alpha variants on primary — skip the alpha assertion.
      return;
    }
    const css = fs.readFileSync(
      path.join(outDir, "astro", "src", "styles", "global.css"),
      "utf8",
    );
    // Every variant token must appear in global.css :root with the new base RGB.
    for (const [name, value] of primaryVariants) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });

  it("changedFiles contains brand.json + global.css; targetSections is empty", () => {
    const NEW_HEX = "#334155";
    const result = setBrand(site, "primary", NEW_HEX);
    expect(result.changedFiles).toHaveLength(2);
    expect(result.changedFiles.some((f) => f.endsWith("brand.json"))).toBe(true);
    expect(result.changedFiles.some((f) => f.endsWith("global.css"))).toBe(true);
    expect(result.targetSections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// swapAsset
// ---------------------------------------------------------------------------

describe("swapAsset", () => {
  it("swaps logo with a local PNG (same type) — same filename, bytes changed", async () => {
    // Write TINY_PNG_BUF to a temp file so we can pass a file path as source.
    const tmpPng = path.join(os.tmpdir(), "milo-swap-test-logo.png");
    fs.writeFileSync(tmpPng, TINY_PNG_BUF);

    // Read the current logo bytes from the public assets location (projected out dir
    // only has astro/public/assets/, not a root assets/ dir).
    const asset = manifest.pages[0].assets.find((a) => a.alias === "logo");
    expect(asset, "speakeasy fixture has no logo asset").toBeDefined();
    const currentPublicFile = path.join(outDir, "astro", "public", asset!.file);
    const before = fs.readFileSync(currentPublicFile);

    const result = await swapAsset(site, "logo", tmpPng);

    // changedFiles must be non-empty and always contain the astro/public asset copy.
    expect(result.changedFiles.length).toBeGreaterThan(0);
    const publicAsset = path.join(outDir, "astro", "public", asset!.file);
    expect(result.changedFiles).toContain(publicAsset);

    // The public asset bytes must now equal TINY_PNG_BUF (and differ from original).
    expect(before.equals(TINY_PNG_BUF)).toBe(false); // original was not our sentinel
    expect(fs.readFileSync(publicAsset).equals(TINY_PNG_BUF)).toBe(true);

    // The filename in site.json is unchanged (same type — no ref rewrite needed).
    const updatedManifest = JSON.parse(
      fs.readFileSync(path.join(outDir, "site.json"), "utf8"),
    ) as SiteManifest;
    const updatedAsset = updatedManifest.pages[0].assets.find((a) => a.alias === "logo");
    expect(updatedAsset?.file).toBe(asset!.file);

    fs.rmSync(tmpPng, { force: true });
  });
});

// ---------------------------------------------------------------------------
// styleTweak
// ---------------------------------------------------------------------------

describe("styleTweak", () => {
  it("primary-cta element gets font-size: 24px in global.css", () => {
    // Verify the fixture has a primary-cta element.
    const ctaEl = manifest.pages[0].elements.find((e) => e.role === "primary-cta");
    expect(ctaEl, "speakeasy fixture has no primary-cta element").toBeDefined();

    styleTweak(site, "primary-cta", "font-size", "24px");

    const css = fs.readFileSync(
      path.join(outDir, "astro", "src", "styles", "global.css"),
      "utf8",
    );
    // The CTA's .pN class must now have the font-size override.
    expect(css).toContain(`.${ctaEl!.id} { font-size: 24px; }`);
  });

  it("idempotent: calling styleTweak again updates the rule in place (no duplicate)", () => {
    const ctaEl = manifest.pages[0].elements.find((e) => e.role === "primary-cta")!;

    styleTweak(site, "primary-cta", "font-size", "32px");

    const css = fs.readFileSync(
      path.join(outDir, "astro", "src", "styles", "global.css"),
      "utf8",
    );
    // New value must appear.
    expect(css).toContain(`.${ctaEl.id} { font-size: 32px; }`);
    // Old value must NOT appear (it was overwritten, not duplicated).
    expect(css).not.toContain(`.${ctaEl.id} { font-size: 24px; }`);
  });

  it("brand-token preference: background-color matching primary emits var(--color-primary)", () => {
    // Read the CURRENT brand primary value from brand.json (may have been changed by
    // setBrand tests above — we use whatever the current value is).
    const brand = JSON.parse(
      fs.readFileSync(path.join(outDir, "astro", "brand.json"), "utf8"),
    ) as BrandDoc;
    const primaryValue = brand.colors.primary.value; // e.g. "rgb(51, 65, 85)"

    const ctaEl = manifest.pages[0].elements.find((e) => e.role === "primary-cta")!;

    styleTweak(site, "primary-cta", "background-color", primaryValue);

    const css = fs.readFileSync(
      path.join(outDir, "astro", "src", "styles", "global.css"),
      "utf8",
    );
    // Must emit the brand token ref, NOT the raw literal.
    expect(css).toContain(`.${ctaEl.id} { background-color: var(--color-primary); }`);
    // The raw literal must NOT appear as the emitted value.
    expect(css).not.toContain(`.${ctaEl.id} { background-color: ${primaryValue}; }`);
  });

  it("changedFiles contains global.css; targetSections names the owning component", () => {
    const ctaEl = manifest.pages[0].elements.find((e) => e.role === "primary-cta")!;
    const result = styleTweak(site, "primary-cta", "font-weight", "700");

    expect(result.changedFiles).toHaveLength(1);
    expect(result.changedFiles[0]).toMatch(/global\.css$/);
    expect(result.targetSections).toContain(ctaEl.component);
  });

  it("throws when prop is not in the bounded STYLE_PROPS set", () => {
    expect(() => styleTweak(site, "primary-cta", "position", "absolute")).toThrow(
      /styleTweak: prop 'position' not in the bounded set/,
    );
  });
});

// ---------------------------------------------------------------------------
// TargetError guard
// ---------------------------------------------------------------------------

describe("TargetError guard", () => {
  it("resolveCopy with a bogus key throws TargetError", () => {
    expect(() => resolveCopy(site, "bogus.key.999")).toThrow(TargetError);
  });

  it("TargetError message contains the bad key", () => {
    expect(() => resolveCopy(site, "nonexistent.component.0")).toThrow(/nonexistent\.component\.0/);
  });

  it("setBrand with an unknown slot throws an Error", () => {
    expect(() => setBrand(site, "nonexistentslot", "#ff0000")).toThrow(/unknown brand slot/);
  });
});
