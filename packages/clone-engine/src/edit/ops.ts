/**
 * ops.ts — deterministic edit operations over a PROJECTED out dir.
 *
 * These are the two primitives subsystem C (Task 1) rests on. They operate on
 * the already-projected Astro artifact (site.json + astro/), never on the live
 * capture, and they are pure/deterministic: given the same (site, target, value)
 * they produce the same bytes.
 *
 *   editCopy(site, copyKey, text)   — swap one editable copy string.
 *   setBrand(site, slot, value)     — recolor one brand slot everywhere.
 *
 * setBrand REUSES the engine's own flattenRoot() (from brand.ts) rather than
 * re-implementing the cascade, so edits go through the exact same code path
 * that project() uses. Ported from experiments/edit-slice/edit-ops.mjs and typed
 * with full error handling.
 */
import fs from "node:fs";
import path from "node:path";
import type { SiteRef, EditOp, OpResult } from "./types.ts";
import { resolveCopy } from "./target.ts";
import { flattenRoot } from "../brand.ts";
import type { BrandDoc } from "../types.ts";

// ---------------------------------------------------------------------------
// editCopy
// ---------------------------------------------------------------------------

/**
 * Replace one editable copy string at the given copy key.
 *
 * Resolves the key via site.json → opens the owning component .astro → safely
 * parses its `const content = [...]` literal → replaces element at contentIndex →
 * rewrites the file. Everything else (whitespace, HTML template, other components)
 * is preserved byte-for-byte.
 */
export function editCopy(site: SiteRef, copyKey: string, text: string): OpResult {
  const { file, contentIndex, component } = resolveCopy(site, copyKey);
  const src = fs.readFileSync(file, "utf8");

  const { array, start, end } = parseContentArray(src, file);
  if (contentIndex < 0 || contentIndex >= array.length) {
    throw new Error(
      `editCopy: index ${contentIndex} out of range (len ${array.length}) in ${component}`,
    );
  }
  array[contentIndex] = text;

  const rebuilt = src.slice(0, start) + serializeContentArray(array) + src.slice(end);
  fs.writeFileSync(file, rebuilt);

  const op: EditOp = { op: "editCopy", copyKey, text };
  return { op, changedFiles: [file], targetSections: [component] };
}

/**
 * Parse the `const content = [ ... ];` literal at the top of a projected .astro
 * component. Returns the decoded string array plus the [start, end) byte span of
 * the `[...]` literal so the edit can splice a re-serialized array back in place.
 *
 * The projector always emits a JSON-compatible array of double-quoted strings, so
 * JSON.parse of the bracket span is exact. The bracket-walker respects string
 * literals + backslash escapes so nested brackets in copy text are handled safely.
 */
function parseContentArray(
  src: string,
  file: string,
): { array: string[]; start: number; end: number } {
  const marker = "const content = ";
  const declStart = src.indexOf(marker);
  if (declStart === -1) throw new Error(`editCopy: no 'const content =' in ${file}`);
  const start = src.indexOf("[", declStart);
  if (start === -1) throw new Error(`editCopy: no content array open bracket in ${file}`);

  // Walk to the matching close bracket, respecting string literals + escapes.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`editCopy: unterminated content array in ${file}`);

  const array = JSON.parse(src.slice(start, end)) as string[];
  return { array, start, end };
}

/** Serialize the content array in the same shape the projector emits (one string per line). */
function serializeContentArray(array: string[]): string {
  if (array.length === 0) return "[]";
  const body = array.map((s) => "  " + JSON.stringify(s)).join(",\n");
  return `[\n${body}\n]`;
}

// ---------------------------------------------------------------------------
// setBrand
// ---------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function hexToRgb(hex: string): [number, number, number] {
  const m = HEX_RE.exec(hex);
  if (!m) throw new Error(`setBrand: value must be #rrggbb, got: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Parse an `rgb(...)`/`rgba(...)` literal → [r,g,b,a] (a defaults to 1). */
function parseCssColor(v: string): [number, number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(v);
  if (!m) return null;
  return [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] === undefined ? 1 : Number(m[4]),
  ];
}

/**
 * Recolor one brand slot. Rewrites astro/brand.json (slot value + hex, and
 * recomputes each alpha variant from the new base RGB, preserving each variant's
 * original alpha) then regenerates the `:root` block in global.css via flattenRoot,
 * so every `var(--color-<slot>)` and `var(--color-<slot>-NN)` ref recolors at once.
 *
 * Non-brand "extra" tokens already in `:root` are preserved verbatim: we re-derive
 * them by diffing the current `:root` against the set of names flattenRoot owns.
 */
export function setBrand(site: SiteRef, slot: string, newHex: string): OpResult {
  const brandPath = path.join(site.dir, "astro", "brand.json");
  if (!fs.existsSync(brandPath)) {
    throw new Error(`setBrand: brand.json not found at ${brandPath}`);
  }
  const brand = JSON.parse(fs.readFileSync(brandPath, "utf8")) as BrandDoc;

  const colorSlots = brand.colors as Record<string, { value: string; hex: string; variants: Record<string, string> }>;
  if (!colorSlots[slot]) {
    throw new Error(`setBrand: unknown brand slot "${slot}". Valid slots: ${Object.keys(colorSlots).join(", ")}`);
  }

  const [r, g, b] = hexToRgb(newHex);
  const slotObj = colorSlots[slot];

  // New base value: opaque rgb(...) in the literal shape the engine emits.
  slotObj.value = `rgb(${r}, ${g}, ${b})`;
  slotObj.hex = newHex.toLowerCase();

  // Recompute each alpha variant from the new base RGB, KEEPING each variant's original alpha.
  const newVariants: Record<string, string> = {};
  for (const [name, literal] of Object.entries(slotObj.variants)) {
    const parsed = parseCssColor(literal);
    const alpha = parsed ? parsed[3] : 1;
    newVariants[name] =
      alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  slotObj.variants = newVariants;

  fs.writeFileSync(brandPath, JSON.stringify(brand, null, 2) + "\n");

  // Regenerate the :root block in global.css — preserving non-brand extra tokens verbatim.
  const cssPath = path.join(site.dir, "astro", "src", "styles", "global.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const { block, start, end } = extractRootBlock(css);
  const extra = extraLinesFromRoot(block, brand);
  const newRoot = flattenRoot(brand, extra);
  const rebuilt = css.slice(0, start) + newRoot + css.slice(end);
  fs.writeFileSync(cssPath, rebuilt);

  const op: EditOp = { op: "setBrand", slot: slot as "primary" | "accent" | "surface" | "text" | "muted", value: newHex };
  return {
    op,
    changedFiles: [brandPath, cssPath],
    targetSections: [],
  };
}

/** Extract the first `:root { ... }` block + its byte span. */
function extractRootBlock(css: string): { block: string; start: number; end: number } {
  const start = css.indexOf(":root {");
  if (start === -1) throw new Error("setBrand: no :root block in global.css");
  const close = css.indexOf("}", start);
  if (close === -1) throw new Error("setBrand: unterminated :root block");
  const end = close + 1;
  return { block: css.slice(start, end), start, end };
}

/**
 * From the existing `:root` block, return the "extra" (non-brand) custom-property
 * lines — everything flattenRoot does NOT own. flattenRoot owns: --color-<slot>,
 * --color-<slot>-<NN> variants, --font-display/body, --space-*, --radius-*. Any
 * other `  --name: value;` line is a per-literal leftover token that must be
 * preserved verbatim across the regeneration.
 */
function extraLinesFromRoot(block: string, brand: BrandDoc): string[] {
  const owned = new Set<string>(["--font-display", "--font-body"]);
  for (const k of Object.keys(brand.space ?? {})) owned.add(`--space-${k}`);
  for (const k of Object.keys(brand.radius ?? {})) owned.add(`--radius-${k}`);
  const colorSlots = brand.colors as Record<string, { variants: Record<string, string> }>;
  for (const slot of Object.keys(colorSlots)) {
    owned.add(`--color-${slot}`);
    for (const vName of Object.keys(colorSlots[slot].variants)) owned.add(vName);
  }

  const extra: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:/.exec(line);
    if (!m) continue; // ":root {" / "}" lines
    if (owned.has(m[1])) continue; // brand-managed, flattenRoot re-emits it
    extra.push(line);
  }
  return extra;
}
