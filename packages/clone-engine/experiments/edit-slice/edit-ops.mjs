/**
 * edit-ops.mjs — deterministic edit operations over a PROJECTED out dir.
 *
 * These are the two primitives the "edit bet" (subsystem C) rests on. They operate on the
 * already-projected Astro artifact (site.json + astro/), never on the live capture, and they
 * are pure/deterministic: given the same (outDir, target, value) they produce the same bytes.
 *
 *   editCopy(outDir, copyKey, newText)  — swap one editable copy string.
 *   setBrand(outDir, slot, newValue)    — recolor one brand slot everywhere.
 *
 * setBrand REUSES the engine's own :root flattener (flattenRoot) rather than re-implementing
 * the cascade, so the demo edits the site through the exact same code path project() uses.
 */
import fs from "node:fs";
import path from "node:path";
// Import the production engine's brand helpers — do not reinvent the cascade.
import { flattenRoot } from "../../src/brand.ts";

// ---------------------------------------------------------------------------
// site.json helpers
// ---------------------------------------------------------------------------

export function readSite(outDir) {
  return JSON.parse(fs.readFileSync(path.join(outDir, "site.json"), "utf8"));
}
export function readBrand(outDir) {
  return JSON.parse(fs.readFileSync(path.join(outDir, "astro", "brand.json"), "utf8"));
}

/** Find a copy entry across all pages by its key. */
export function findCopy(site, copyKey) {
  for (const page of site.pages) {
    const entry = page.copy.find((c) => c.key === copyKey);
    if (entry) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// editCopy
// ---------------------------------------------------------------------------

/**
 * Replace one editable copy string. Looks the key up in site.json → gets the owning
 * component + index into that component's `content[]` array → replaces exactly that element
 * in the component's .astro source. Everything else (whitespace slots, HTML template, other
 * components) is preserved byte-for-byte.
 */
export function editCopy(outDir, copyKey, newText) {
  const site = readSite(outDir);
  const entry = findCopy(site, copyKey);
  if (!entry) throw new Error(`editCopy: copy key not found in site.json: ${copyKey}`);

  const file = path.join(outDir, "astro", "src", "components", `${entry.component}.astro`);
  const src = fs.readFileSync(file, "utf8");

  const { array, start, end } = parseContentArray(src, file);
  if (entry.index < 0 || entry.index >= array.length) {
    throw new Error(`editCopy: index ${entry.index} out of range (len ${array.length}) in ${entry.component}`);
  }
  const before = array[entry.index];
  array[entry.index] = newText;

  const rebuilt = src.slice(0, start) + serializeContentArray(array) + src.slice(end);
  fs.writeFileSync(file, rebuilt);
  return { file, component: entry.component, index: entry.index, before, after: newText };
}

/**
 * Parse the `const content = [ ... ];` literal at the top of a projected .astro component.
 * Returns the decoded string array plus the [start,end) byte span of the `[...]` literal so
 * the edit can splice a re-serialized array back in place. The projector always emits a
 * JSON-compatible array of double-quoted strings, so JSON.parse of the bracket span is exact.
 */
function parseContentArray(src, file) {
  const marker = "const content = ";
  const declStart = src.indexOf(marker);
  if (declStart === -1) throw new Error(`editCopy: no 'const content =' in ${file}`);
  const start = src.indexOf("[", declStart);
  if (start === -1) throw new Error(`editCopy: no content array open bracket in ${file}`);
  // Walk to the matching close bracket, respecting string literals + escapes.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < src.length; i++) {
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
  if (end === -1) throw new Error(`editCopy: unterminated content array in ${file}`);
  const array = JSON.parse(src.slice(start, end));
  return { array, start, end };
}

/** Serialize the content array the same shape the projector emits (one string per line). */
function serializeContentArray(array) {
  if (array.length === 0) return "[]";
  const body = array.map((s) => "  " + JSON.stringify(s)).join(",\n");
  return `[\n${body}\n]`;
}

// ---------------------------------------------------------------------------
// setBrand
// ---------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function hexToRgb(hex) {
  const m = HEX_RE.exec(hex);
  if (!m) throw new Error(`setBrand: value must be #rrggbb, got: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Parse an `rgb(...)`/`rgba(...)` literal → [r,g,b,a] (a defaults to 1). */
function parseCssColor(v) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/**
 * Recolor one brand slot. Rewrites astro/brand.json (slot value + hex, and recomputes each
 * alpha variant from the new base RGB, preserving the variant's alpha) then regenerates the
 * :root block in global.css FROM brand.json via the engine's flattenRoot — so every
 * var(--color-<slot>) / var(--color-<slot>-NN) reference in the CSS recolors at once.
 *
 * The non-brand "extra" tokens already in :root are preserved verbatim: we re-derive them by
 * diffing the current :root against the set of names flattenRoot owns, and pass them through.
 */
export function setBrand(outDir, slot, newHex) {
  const brandPath = path.join(outDir, "astro", "brand.json");
  const brand = JSON.parse(fs.readFileSync(brandPath, "utf8"));
  if (!brand.colors[slot]) throw new Error(`setBrand: unknown slot ${slot}`);

  const [r, g, b] = hexToRgb(newHex);
  const slotObj = brand.colors[slot];
  const beforeValue = slotObj.value;

  // New base value: opaque rgb(...) in the same literal shape the engine emits.
  slotObj.value = `rgb(${r}, ${g}, ${b})`;
  slotObj.hex = newHex.toLowerCase();
  // Recompute each alpha variant from the new base, KEEPING each variant's original alpha.
  const newVariants = {};
  for (const [name, literal] of Object.entries(slotObj.variants)) {
    const parsed = parseCssColor(literal);
    const alpha = parsed ? parsed[3] : 1;
    newVariants[name] = alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  slotObj.variants = newVariants;

  fs.writeFileSync(brandPath, JSON.stringify(brand, null, 2) + "\n");

  // Regenerate :root from brand.json, preserving the non-brand extra tokens verbatim.
  const cssPath = path.join(outDir, "astro", "src", "styles", "global.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const { block, start, end } = extractRootBlock(css);
  const extra = extraLinesFromRoot(block, brand);
  const newRoot = flattenRoot(brand, extra);
  const rebuilt = css.slice(0, start) + newRoot + css.slice(end);
  fs.writeFileSync(cssPath, rebuilt);

  return { slot, beforeValue, afterValue: slotObj.value, hex: slotObj.hex, extraCount: extra.length };
}

/** Extract the first `:root { ... }` block + its byte span. */
function extractRootBlock(css) {
  const start = css.indexOf(":root {");
  if (start === -1) throw new Error("setBrand: no :root block in global.css");
  const close = css.indexOf("}", start);
  if (close === -1) throw new Error("setBrand: unterminated :root block");
  const end = close + 1;
  return { block: css.slice(start, end), start, end };
}

/**
 * From the existing :root block, return the "extra" (non-brand) custom-property lines —
 * everything flattenRoot does NOT own. flattenRoot owns: --color-<slot>, --color-<slot>-<NN>
 * variants, --font-display/body, --space-*, --radius-*. Any other `  --name: value;` line is a
 * per-literal leftover token that must be preserved verbatim across the regeneration.
 */
function extraLinesFromRoot(block, brand) {
  const owned = new Set(["--font-display", "--font-body"]);
  for (const k of Object.keys(brand.space ?? {})) owned.add(`--space-${k}`);
  for (const k of Object.keys(brand.radius ?? {})) owned.add(`--radius-${k}`);
  for (const slot of Object.keys(brand.colors)) {
    owned.add(`--color-${slot}`);
    for (const vName of Object.keys(brand.colors[slot].variants)) owned.add(vName);
  }
  const extra = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:/.exec(line);
    if (!m) continue; // ":root {" / "}"
    if (owned.has(m[1])) continue; // brand-managed, flattenRoot re-emits it
    extra.push(line);
  }
  return extra;
}
