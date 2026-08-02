/**
 * ops.ts — deterministic edit operations over a PROJECTED out dir.
 *
 * These primitives are what subsystem C rests on. They operate on the already-
 * projected Astro artifact (site.json + astro/), never on the live capture, and
 * they are pure/deterministic: given the same (site, target, value) they produce
 * the same bytes.
 *
 *   editCopy(site, copyKey, text)         — swap one editable copy string.
 *   setBrand(site, slot, value)           — recolor one brand slot everywhere.
 *   swapAsset(site, alias, source)        — replace one rehosted asset file.
 *   styleTweak(site, target, prop, value) — add/override a bounded CSS rule.
 *
 * setBrand REUSES the engine's own flattenRoot() (from brand.ts) rather than
 * re-implementing the cascade, so edits go through the exact same code path
 * that project() uses. Ported from experiments/edit-slice/edit-ops.mjs and typed
 * with full error handling.
 */
import fs from "node:fs";
import path from "node:path";
import type { SiteRef, EditOp, OpResult, StyleProp } from "./types.ts";
import { STYLE_PROPS } from "./types.ts";
import { resolveCopy, resolveAsset, resolveSection, loadSite, TargetError } from "./target.ts";
import { flattenRoot, canon } from "../brand.ts";
import type { BrandDoc, BrandColorSlot, SiteManifest, ManifestSection, ManifestCopyEntry, ManifestPage, ManifestElement, PageType } from "../types.ts";
import { classifyPage, GOAL_OF_TYPE } from "../pagemodel.ts";
import { generatePageMeta } from "./seo-meta.ts";

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

  const colorSlots = brand.colors;
  if (!(slot in colorSlots)) {
    throw new Error(`setBrand: unknown brand slot "${slot}". Valid slots: ${Object.keys(colorSlots).join(", ")}`);
  }

  const [r, g, b] = hexToRgb(newHex);
  const slotObj = colorSlots[slot as keyof BrandDoc["colors"]];

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
  for (const [slot, slotObj] of Object.entries(brand.colors) as Array<[keyof BrandDoc["colors"], BrandColorSlot]>) {
    owned.add(`--color-${slot}`);
    for (const vName of Object.keys(slotObj.variants)) owned.add(vName);
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

// ---------------------------------------------------------------------------
// swapAsset
// ---------------------------------------------------------------------------

/**
 * Sniff the file type of a buffer by magic bytes. Returns a lowercase extension
 * string, or null when the type is unknown/undetectable. This is the same
 * algorithm capture.ts uses (extracted here so ops.ts doesn't need to import the
 * full capture module, which has heavy playwright dependencies).
 */
function sniffExt(b: Buffer): string | null {
  if (b.length < 4) return null;
  const h = b.toString("latin1", 0, 4);
  if (h === "wOFF") return "woff";
  if (h === "wOF2") return "woff2";
  if (h === "OTTO") return "otf";
  if (b[0] === 0x89 && h.slice(1) === "PNG") return "png";
  if (h === "GIF8") return "gif";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (h === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "ttf";
  const head = b.toString("latin1", 0, 200).replace(/^\xEF\xBB\xBF/, "").trim().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

/** Rewrite every `/assets/oldName` reference to `/assets/newName` across all .astro + global.css. */
function rewriteAssetRefs(
  site: SiteRef,
  oldRel: string,   // e.g. "assets/a23.png"
  newRel: string,   // e.g. "assets/a23.webp" (may equal oldRel)
  changedFiles: string[],
): void {
  if (oldRel === newRel) return; // same name → no ref rewrites needed
  const oldSlash = `/${oldRel}`; // "/assets/a23.png"
  const newSlash = `/${newRel}`; // "/assets/a23.webp"

  const componentsDir = path.join(site.dir, "astro", "src", "components");
  const cssPath = path.join(site.dir, "astro", "src", "styles", "global.css");

  const rewriteFile = (filePath: string) => {
    if (!fs.existsSync(filePath)) return;
    const src = fs.readFileSync(filePath, "utf8");
    if (!src.includes(oldSlash)) return;
    const updated = src.replaceAll(oldSlash, newSlash);
    fs.writeFileSync(filePath, updated);
    changedFiles.push(filePath);
  };

  // Rewrite all .astro component files.
  if (fs.existsSync(componentsDir)) {
    for (const name of fs.readdirSync(componentsDir)) {
      if (name.endsWith(".astro")) rewriteFile(path.join(componentsDir, name));
    }
  }

  // Rewrite global.css url() references.
  rewriteFile(cssPath);
}

/**
 * Replace a rehosted asset (identified by its semantic alias, e.g. "logo") with
 * a new file sourced from a local path or a URL.
 *
 * If the new asset has the SAME file type (by magic bytes) as the existing one,
 * the filename stays the same and all existing src/srcset/url() refs keep working
 * without any rewriting. If the type differs, a new filename `aN.<newext>` is
 * written and every `/assets/oldName` reference in .astro components and
 * global.css is rewritten to `/assets/newName`.
 *
 * Both storage locations are updated:
 *   - `<site.dir>/assets/<name>`              (the root rehost dir)
 *   - `<site.dir>/astro/public/assets/<name>` (the Astro static-file dir)
 */
export async function swapAsset(
  site: SiteRef,
  alias: string,
  source: string,
): Promise<OpResult> {
  // Resolve the current asset path from site.json.
  const { file: currentFile } = resolveAsset(site, alias);
  const oldRel = path.relative(site.dir, currentFile); // e.g. "assets/a23.png"
  const oldExt = path.extname(currentFile).slice(1).toLowerCase(); // e.g. "png"

  // Read the new asset bytes — from a URL or a local path.
  let newBuf: Buffer;
  const isUrl = /^https?:\/\//i.test(source);
  if (isUrl) {
    const FETCH_HEADERS = {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      "accept": "*/*",
    };
    const res = await fetch(source, { signal: AbortSignal.timeout(30_000), headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`swapAsset: fetch failed for ${source} (${res.status})`);
    newBuf = Buffer.from(await res.arrayBuffer());
  } else {
    if (!fs.existsSync(source)) throw new Error(`swapAsset: source file not found: ${source}`);
    newBuf = fs.readFileSync(source);
  }

  // Sniff the new asset's type.
  const sniffedExt = sniffExt(newBuf);
  const newExt = sniffedExt ?? (path.extname(source).slice(1).toLowerCase() || oldExt);
  if (newExt === "html") {
    throw new Error(`swapAsset: source resolved to an HTML document, not an asset file`);
  }

  // Determine the output filename — keep the same name when type matches.
  const baseName = path.basename(currentFile, path.extname(currentFile)); // e.g. "a23"
  const sameType = newExt === oldExt;
  const newFileName = sameType ? path.basename(currentFile) : `${baseName}.${newExt}`;
  const newRel = `assets/${newFileName}`; // relative to site.dir

  // Write to both storage locations.
  // The projected out dir stores assets only in astro/public/assets/ (the Astro static-file
  // dir, served as /assets/<name>). Some layouts also keep a root assets/ copy (from the
  // capture step). We write to whichever location exists; the public copy always wins.
  const rootAssetsDir = path.join(site.dir, "assets");
  const rootAssetPath = path.join(site.dir, newRel);
  const publicAssetPath = path.join(site.dir, "astro", "public", newRel);
  fs.mkdirSync(path.dirname(publicAssetPath), { recursive: true });
  fs.writeFileSync(publicAssetPath, newBuf);
  const changedFiles: string[] = [publicAssetPath];
  if (fs.existsSync(rootAssetsDir)) {
    // Root assets/ dir exists (capture + project combined layout) — update it too.
    fs.writeFileSync(rootAssetPath, newBuf);
    changedFiles.unshift(rootAssetPath);
  }

  // Rewrite refs if the filename changed.
  rewriteAssetRefs(site, oldRel, newRel, changedFiles);

  // Update site.json so future resolveAsset calls reflect the new path.
  if (!sameType) {
    const manifestPath = path.join(site.dir, "site.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SiteManifest;
    for (const page of manifest.pages) {
      for (const a of page.assets) {
        if (a.alias === alias) a.file = newRel;
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    changedFiles.push(manifestPath);
  }

  // Find the section(s) that reference this asset for targetSections.
  const manifest = JSON.parse(fs.readFileSync(path.join(site.dir, "site.json"), "utf8")) as SiteManifest;
  const targetSections: string[] = [];
  for (const page of manifest.pages) {
    const asset = page.assets.find((a) => a.alias === alias);
    if (!asset) continue;
    // Find any section whose component file contains a ref to this asset.
    for (const section of page.sections) {
      const sectionFile = path.join(site.dir, section.file);
      if (fs.existsSync(sectionFile)) {
        const src = fs.readFileSync(sectionFile, "utf8");
        if (src.includes(`/assets/${newFileName}`) || src.includes(`/assets/${path.basename(currentFile)}`)) {
          if (!targetSections.includes(section.name)) targetSections.push(section.name);
        }
      }
    }
  }

  const op: EditOp = { op: "swapAsset", alias, source };
  return { op, changedFiles, targetSections };
}

// ---------------------------------------------------------------------------
// styleTweak
// ---------------------------------------------------------------------------

/** CSS props that are color-related (candidates for brand-token substitution). */
const COLOR_PROPS = new Set(["color", "background-color"]);
/** CSS props that are spacing-related (candidates for space-token substitution). */
const SPACING_PROPS = new Set(["padding", "margin", "gap"]);

/**
 * Check whether `value` canon-equals a brand token value and return the
 * corresponding CSS custom-property reference, or null if no token matches.
 *
 * For colors: compares via `canon()` (normalizes rgb/hex/rgba → "r,g,b,a").
 * For spacing: checks exact string match against --space-* token values.
 */
function brandTokenFor(
  prop: string,
  value: string,
  brand: BrandDoc,
): string | null {
  if (COLOR_PROPS.has(prop)) {
    const valueCanon = canon(value);
    // Check base brand color slots.
    for (const [slot, slotObj] of Object.entries(brand.colors) as Array<[keyof BrandDoc["colors"], BrandColorSlot]>) {
      if (canon(slotObj.value) === valueCanon) return `var(--color-${slot})`;
      // Check variants.
      for (const [varName, varValue] of Object.entries(slotObj.variants)) {
        if (canon(varValue) === valueCanon) return `var(${varName})`;
      }
    }
  } else if (SPACING_PROPS.has(prop)) {
    // Exact string match against space tokens (values are simple like "8px", "16px").
    for (const [k, v] of Object.entries(brand.space)) {
      if (v === value) return `var(--space-${k})`;
    }
  }
  return null;
}

/**
 * Look up the brand.json if it exists — returns null when the file is absent
 * (some projected dirs might not have one yet, though all should).
 */
function loadBrandDoc(site: SiteRef): BrandDoc | null {
  const brandPath = path.join(site.dir, "astro", "brand.json");
  if (!fs.existsSync(brandPath)) return null;
  return JSON.parse(fs.readFileSync(brandPath, "utf8")) as BrandDoc;
}

/**
 * Find the `.pN` CSS class handle for a target that is either a data-role
 * (element role) or a section name / section role. Returns `{ id, component }`.
 *
 * Strategy:
 *   1. Try the manifest's elements[] by role — fast path for specific elements.
 *   2. Fall back to resolveSection → read the section's .astro file to find the
 *      root element's `class="pN"` — the first .pN class in the section component.
 */
function resolveTargetId(
  site: SiteRef,
  target: string,
): { id: string; component: string } {
  // Try as element role — walk the manifest directly to get the `id` field.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(site.dir, "site.json"), "utf8"),
  ) as SiteManifest;
  for (const page of manifest.pages) {
    const el = page.elements.find((e) => e.role === target);
    if (el) return { id: el.id, component: el.component };
  }

  // Try as section role/name — take the first .pN class of the root element.
  // resolveSection throws TargetError if not found (propagates to caller).
  const { file, name } = resolveSection(site, target);
  const src = fs.readFileSync(file, "utf8");
  // The root element of every projected component carries class="pN ...".
  // It is inside the template literal: `<tag class="pN"`.
  const m = /class="(p\d+)"/.exec(src);
  if (!m) {
    throw new Error(`styleTweak: could not find a .pN handle in section ${name}`);
  }
  return { id: m[1], component: name };
}

/**
 * Add or override a single CSS declaration scoped to the element identified by
 * `target` (a data-role OR a section name/role).
 *
 * The rule is appended to global.css as a high-specificity override block:
 *
 *   /* styleTweak: <target> *\/
 *   .<pN> { <prop>: <value>; }
 *
 * If a previous styleTweak override for the exact same `.<pN> { <prop> }` already
 * exists in global.css, it is updated in place rather than duplicated.
 *
 * `prop` must be in the STYLE_PROPS bounded set — otherwise an error is thrown.
 *
 * Brand-token preference: if `prop` is a color or spacing prop and `value`
 * canon-equals a brand token's value, the emitted CSS uses `var(--color-<slot>)`
 * / `var(--space-<x>)` instead of the raw literal. Use a raw literal when no
 * brand token matches.
 */
export function styleTweak(
  site: SiteRef,
  target: string,
  prop: string,
  value: string,
): OpResult {
  // Guard: prop must be in the bounded set. After this check `prop` is provably a StyleProp;
  // narrow it so the returned op literal matches EditOp's `prop: StyleProp` (parameter stays
  // `string` so callers can pass an out-of-set value and get the throw above).
  if (!(STYLE_PROPS as readonly string[]).includes(prop)) {
    throw new Error(`styleTweak: prop '${prop}' not in the bounded set`);
  }
  const styleProp = prop as StyleProp;

  // Resolve the target to a .pN handle.
  const { id, component } = resolveTargetId(site, target);

  // Prefer a brand token if one matches.
  const brand = loadBrandDoc(site);
  const emitValue = brand ? (brandTokenFor(prop, value, brand) ?? value) : value;

  // Build the rule line.
  const selector = `.${id}`;
  const ruleLine = `${selector} { ${prop}: ${emitValue}; }`;
  const commentLine = `/* styleTweak: ${target} */`;

  // Read global.css.
  const cssPath = path.join(site.dir, "astro", "src", "styles", "global.css");
  let css = fs.readFileSync(cssPath, "utf8");

  // Check for an existing override for this exact selector + prop.
  // Pattern: .<pN> { <prop>: ...; } (may be multi-prop block or single-prop).
  // We search for a single-prop rule block emitted by a prior styleTweak call.
  // Regex: `<selector> { <prop>: <anything>; }` on a single line.
  const existingRe = new RegExp(
    String.raw`${selector.replace(".", "\\.")} \{ ${prop.replace("-", "\\-")}: [^}]+; \}`,
    "g",
  );
  if (existingRe.test(css)) {
    // Update in place.
    const updated = css.replace(existingRe, ruleLine);
    fs.writeFileSync(cssPath, updated);
  } else {
    // Append a new override block.
    const block = `\n${commentLine}\n${ruleLine}\n`;
    fs.writeFileSync(cssPath, css + block);
  }

  const op: EditOp = { op: "styleTweak", target, prop: styleProp, value };
  return { op, changedFiles: [cssPath], targetSections: [component] };
}

// ---------------------------------------------------------------------------
// Shared helpers for index.astro manipulation
// ---------------------------------------------------------------------------

/**
 * Find all `<ComponentName />` tags in the template body of an index.astro file.
 * Returns an array of { compName, start, end } where [start, end) is the span of the
 * entire self-closing tag (including any surrounding whitespace captured by the match).
 *
 * The projector may place all section includes on a single line OR on separate lines;
 * both layouts are handled identically by operating at the string/offset level.
 *
 * Only uppercase-first component names (PascalCase) are matched — this excludes HTML
 * void elements like `<meta ... />` and Astro built-ins like `<Fragment ... />`.
 */
interface IncludeToken { compName: string; start: number; end: number }

function parseIncludes(src: string): IncludeToken[] {
  // Match `<ComponentName />` — PascalCase only, no attributes (section includes are bare).
  // The leading/trailing space is intentionally NOT part of the match so that removal
  // leaves the surrounding content intact without double-spacing.
  const re = /<([A-Z][A-Za-z0-9]*)\s*\/>/g;
  const tokens: IncludeToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    tokens.push({ compName: m[1], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * Remove the import statement for `name` from the frontmatter section of an .astro file.
 * Handles both import-per-line and any whitespace layout. Returns the modified source.
 */
function stripImport(src: string, name: string): string {
  // Match: `import <Name> from "...";` on its own line (possibly with leading whitespace).
  return src
    .split("\n")
    .filter((line) => !new RegExp(`^\\s*import\\s+${name}\\s+from`).test(line))
    .join("\n");
}

/**
 * Generate a unique component name by suffixing "Copy", "Copy2", "Copy3", ... until
 * no collision with any existing file under `componentsDir` AND no collision with any
 * section name in `site.json`. This guarantees the new component file can be written
 * without clobbering anything.
 */
function uniqueComponentName(baseName: string, site: SiteRef): string {
  const componentsDir = path.join(site.dir, "astro", "src", "components");
  const manifest = loadSite(site);
  const existingNames = new Set<string>();
  // Collect all existing component file stems.
  if (fs.existsSync(componentsDir)) {
    for (const f of fs.readdirSync(componentsDir)) {
      if (f.endsWith(".astro")) existingNames.add(f.slice(0, -".astro".length));
    }
  }
  // Also collect all section names from site.json (a component may have been added
  // without a file yet, or a file may exist without a section entry).
  for (const page of manifest.pages) {
    for (const s of page.sections) existingNames.add(s.name);
  }

  // Generate: <baseName>Copy, <baseName>Copy2, <baseName>Copy3, ...
  let candidate = baseName + "Copy";
  let i = 2;
  while (existingNames.has(candidate)) {
    candidate = baseName + "Copy" + i++;
  }
  return candidate;
}

/**
 * Rewrite the copy-key namespace inside a cloned component's `html` template literal
 * so the clone's editable slots are addressable under the NEW component name instead of
 * the original. Two substitutions:
 *
 *   data-component="OldName"  →  data-component="NewName"
 *   data-copy="OldName.N"     →  data-copy="NewName.N"   (space-separated lists too)
 *
 * The copy[] in site.json will then be built from the NEW keys so `editCopy("NewName.N")`
 * resolves to the clone's file and NOT the original's.
 *
 * Note: the cloned component's `.pN` CSS classes are SHARED with the original section —
 * they both reference the same class names in global.css, so `styleTweak` on a `.pN`
 * target would affect both sections. This is an accepted v1 limit. A caller can make
 * the clone visually distinct via `editCopy` to change its text content.
 */
function rewriteComponentRefs(src: string, oldName: string, newName: string): string {
  const escName = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Rewrite data-component="OldName" → data-component="NewName"
  let out = src.replace(
    new RegExp(`data-component="${escName}"`, "g"),
    `data-component="${newName}"`,
  );
  // Rewrite data-copy="OldName.N" and "OldName.N OldName.M" (space-separated multi-key lists).
  // Match the entire data-copy="..." attribute value and replace each OldName. prefix.
  out = out.replace(
    new RegExp(`data-copy="(${escName}\\.[^"]*)"`, "g"),
    (_: string, keys: string) => {
      const newKeys = keys
        .replace(new RegExp(`^${escName}\\.`, "g"), `${newName}.`)
        .replace(new RegExp(` ${escName}\\.`, "g"), ` ${newName}.`);
      return `data-copy="${newKeys}"`;
    },
  );
  return out;
}

// ---------------------------------------------------------------------------
// removeSection
// ---------------------------------------------------------------------------

/**
 * Remove a section from a projected site.
 *
 * Steps (resolve throws before any write; file mutations are sequential, not transactional):
 *   1. Resolve the section via site.json (throws TargetError if absent).
 *   2. Delete the component .astro file.
 *   3. Strip the import statement + the `<Component />` include from index.astro.
 *      Works with both one-include-per-line and all-inline layouts.
 *   4. Drop the section from site.json pages[].sections AND its owned copy[] entries
 *      (by copyKeys) AND its owned elements[] entries (by elementRoles[].role).
 *
 * Returns an OpResult with changedFiles + targetSections set to the removed name.
 * Leaves the astro/ directory in a buildable state (no dangling imports).
 */
export function removeSection(site: SiteRef, sectionName: string): OpResult {
  // 1. Resolve — throws TargetError if the section is not found.
  const { file: componentFile, name } = resolveSection(site, sectionName);

  const idxPath = path.join(site.dir, "astro", "src", "pages", "index.astro");
  const manifestPath = path.join(site.dir, "site.json");

  const changedFiles: string[] = [];

  // 2. Delete the component file.
  if (fs.existsSync(componentFile)) {
    fs.rmSync(componentFile);
    changedFiles.push(componentFile);
  }

  // 3. Strip import + include from index.astro.
  if (fs.existsSync(idxPath)) {
    let idx = fs.readFileSync(idxPath, "utf8");

    // Remove the import statement for this component.
    idx = stripImport(idx, name);

    // Remove ALL occurrences of `<Name />` (handles both inline and per-line layouts).
    // We use parseIncludes to find exact byte spans and splice them out — no regex
    // replace that might accidentally corrupt other content.
    const tokens = parseIncludes(idx).filter((t) => t.compName === name);
    // Walk backwards so earlier offsets remain valid after each splice.
    for (let i = tokens.length - 1; i >= 0; i--) {
      const { start, end } = tokens[i];
      // Strip a single leading space if one exists before the tag (avoids double-space).
      const trimStart = start > 0 && idx[start - 1] === " " ? start - 1 : start;
      idx = idx.slice(0, trimStart) + idx.slice(end);
    }

    fs.writeFileSync(idxPath, idx);
    changedFiles.push(idxPath);
  }

  // 4. Update site.json: drop section, its copy entries, and its element entries.
  const manifest = loadSite(site);
  for (const page of manifest.pages) {
    const section = page.sections.find((s) => s.name === name);
    if (!section) continue;

    // Gather the copy keys owned by this section so we can drop them from copy[].
    const ownedKeys = new Set(section.copyKeys);

    page.sections = page.sections.filter((s) => s.name !== name);
    page.copy = page.copy.filter((c) => !ownedKeys.has(c.key));
    // Remove element entries owned by this section. Scope STRICTLY by component —
    // an element's `component` already identifies its owning section. Do NOT also
    // filter by role: roles are not globally unique (two sections can both have a
    // "headline"/"cta"), so a role-based drop would delete a surviving section's
    // elements. This matters once addSection (T5) clones a section's roles.
    page.elements = page.elements.filter((e) => e.component !== name);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  changedFiles.push(manifestPath);

  const op: EditOp = { op: "removeSection", section: sectionName };
  return { op, changedFiles, targetSections: [name] };
}

// ---------------------------------------------------------------------------
// reorderSection
// ---------------------------------------------------------------------------

/**
 * Move a section to a new position in the rendered include order.
 *
 * The `toIndex` is the desired zero-based position in the final section array
 * (matching the `reorderSection` EditOp variant). Only the `<Component />` include
 * order in index.astro and the sections[] array in site.json are changed; import
 * declarations can stay in any order (they are not rendered positionally).
 *
 * Handles both one-include-per-line and all-inline projector layouts.
 *
 * Returns an OpResult with changedFiles + targetSections set to the moved name.
 */
export function reorderSection(site: SiteRef, sectionName: string, toIndex: number): OpResult {
  // Resolve — throws TargetError if the section is not found.
  const { name } = resolveSection(site, sectionName);

  const idxPath = path.join(site.dir, "astro", "src", "pages", "index.astro");
  const manifestPath = path.join(site.dir, "site.json");

  const changedFiles: string[] = [];

  // --- Reorder the <Component /> include tokens in index.astro ---
  if (fs.existsSync(idxPath)) {
    const src = fs.readFileSync(idxPath, "utf8");
    const tokens = parseIncludes(src);

    if (!tokens.find((t) => t.compName === name)) {
      throw new Error(`reorderSection: could not find <${name} /> include in index.astro`);
    }

    const clampedIndex = Math.max(0, Math.min(toIndex, tokens.length - 1));
    const fromPos = tokens.findIndex((t) => t.compName === name);

    if (fromPos !== clampedIndex) {
      // Extract the original tag text for the moved section.
      const movedTag = src.slice(tokens[fromPos].start, tokens[fromPos].end);

      // Build a new order of tag strings.
      const tagStrings = tokens.map((t) => src.slice(t.start, t.end));
      tagStrings.splice(fromPos, 1);
      tagStrings.splice(clampedIndex, 0, movedTag);

      // Rebuild index.astro by collecting the text BETWEEN include tokens and
      // re-joining it with the reordered tag strings (offset arithmetic-free).
      const segments: string[] = [];
      let cursor = 0;
      for (const tok of tokens) {
        segments.push(src.slice(cursor, tok.start)); // text before this token
        cursor = tok.end;
      }
      segments.push(src.slice(cursor)); // text after the last token

      // Interleave segments and reordered tags.
      let result = segments[0];
      for (let i = 0; i < tagStrings.length; i++) {
        result += tagStrings[i] + segments[i + 1];
      }

      fs.writeFileSync(idxPath, result);
      changedFiles.push(idxPath);
    }
  }

  // --- Reorder sections[] in site.json to match ---
  const manifest = loadSite(site);
  let affectedNames: string[] = [name];
  for (const page of manifest.pages) {
    const fromPos = page.sections.findIndex((s) => s.name === name);
    if (fromPos === -1) continue;
    const clampedIndex = Math.max(0, Math.min(toIndex, page.sections.length - 1));
    if (fromPos !== clampedIndex) {
      // All sections in the range [min, max] shift position — they may render with slightly
      // different sub-pixel values at their new Y coordinates, so we report them all as affected.
      const lo = Math.min(fromPos, clampedIndex);
      const hi = Math.max(fromPos, clampedIndex);
      affectedNames = page.sections.slice(lo, hi + 1).map((s) => s.name);
      const [moved] = page.sections.splice(fromPos, 1);
      page.sections.splice(clampedIndex, 0, moved);
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  changedFiles.push(manifestPath);

  const op: EditOp = { op: "reorderSection", section: sectionName, toIndex };
  return { op, changedFiles, targetSections: affectedNames };
}

// ---------------------------------------------------------------------------
// addSection
// ---------------------------------------------------------------------------

/**
 * Clone an existing section as a new, independently-editable section inserted AFTER
 * `afterSection` (or at the end of the page if omitted).
 *
 * Steps:
 *   1. Resolve `cloneOf` via resolveSection (throws TargetError if absent).
 *   2. Generate a unique new component name (e.g. StoriesOfGlorySectionCopy).
 *   3. Copy the source .astro → new file, rewriting data-component + data-copy refs
 *      to use the NEW name so the clone's copy is independently addressable.
 *   4. Insert `import NewName from "..."` + `<NewName />` AFTER `afterSection`'s
 *      include (or at end if omitted) in index.astro.
 *   5. Add sections[]/copy[]/elements[] entries to site.json under the new name.
 *   6. Return OpResult { changedFiles, targetSections: [newName] }.
 *
 * SHARED .pN CLASSES (v1 limit): the cloned component reuses the source's .pN CSS
 * class names. A styleTweak targeting a .pN handle would affect BOTH the original
 * and the clone. Use editCopy to make the clone textually distinct.
 *
 * VERIFIER NOTE: for the addSection op the caller MUST provide intent.expectedSectionOrder
 * (verify() throws without it). The added section is proven present structurally (DOM +
 * site.json order check) and the Astro build confirms it renders. Pixel-level proof of
 * the ADDED section's internal content is not provided by the verifier (position-independent
 * 0-px applies only to UNTOUCHED sections; the new section has no "before" crop to diff
 * against). This is the correct behavior: structural + render-sanity is the guarantee.
 */
export function addSection(
  site: SiteRef,
  cloneOf: string,
  afterSection?: string,
): OpResult {
  // 1. Resolve the source section — throws TargetError if not found.
  const { file: srcFile, name: srcName } = resolveSection(site, cloneOf);

  // 2. Generate a unique new component name.
  const newName = uniqueComponentName(srcName, site);
  const newFileName = `${newName}.astro`;
  const componentsDir = path.join(site.dir, "astro", "src", "components");
  const newFile = path.join(componentsDir, newFileName);

  // 3. Copy the source .astro → new file with rewritten refs.
  const srcContent = fs.readFileSync(srcFile, "utf8");
  const newContent = rewriteComponentRefs(srcContent, srcName, newName);
  fs.mkdirSync(componentsDir, { recursive: true });
  fs.writeFileSync(newFile, newContent);

  const changedFiles: string[] = [newFile];

  // 4. Insert import + include in index.astro.
  const idxPath = path.join(site.dir, "astro", "src", "pages", "index.astro");
  if (fs.existsSync(idxPath)) {
    let idx = fs.readFileSync(idxPath, "utf8");

    // Resolve the afterSection component name (may be null → append at end).
    let afterName: string | null = null;
    if (afterSection) {
      try {
        afterName = resolveSection(site, afterSection).name;
      } catch {
        // afterSection not found → fall back to appending at end (no throw: addSection
        // should still succeed; the position is advisory).
        afterName = null;
      }
    }

    // Insert the import statement: place it right after the last existing import.
    const importLine = `import ${newName} from "../components/${newFileName}";`;
    const lastImportMatch = [...idx.matchAll(/^import\s+\S+\s+from\s+"[^"]+";/gm)];
    if (lastImportMatch.length > 0) {
      const last = lastImportMatch[lastImportMatch.length - 1];
      const insertAt = last.index! + last[0].length;
      idx = idx.slice(0, insertAt) + "\n" + importLine + idx.slice(insertAt);
    } else {
      // No existing imports — add before the closing ---
      const frontmatterClose = idx.indexOf("\n---\n");
      if (frontmatterClose !== -1) {
        idx = idx.slice(0, frontmatterClose) + "\n" + importLine + idx.slice(frontmatterClose);
      }
    }

    // Insert the <NewName /> include AFTER the afterSection include (or at end of body).
    const newTag = `<${newName} />`;
    const tokens = parseIncludes(idx);
    if (afterName) {
      const afterTok = tokens.find((t) => t.compName === afterName);
      if (afterTok) {
        // Insert the new tag immediately after afterSection's closing `/>`.
        idx = idx.slice(0, afterTok.end) + " " + newTag + idx.slice(afterTok.end);
      } else {
        // afterSection include not found (shouldn't happen but be safe) — append before </body>.
        idx = idx.replace("</body>", ` ${newTag} </body>`);
      }
    } else {
      // No afterSection: append at the end of the existing includes.
      // Re-parse after the import insert so token offsets are current.
      const refreshed = parseIncludes(idx);
      if (refreshed.length > 0) {
        const last = refreshed[refreshed.length - 1];
        idx = idx.slice(0, last.end) + " " + newTag + idx.slice(last.end);
      } else {
        idx = idx.replace("</body>", ` ${newTag} </body>`);
      }
    }

    fs.writeFileSync(idxPath, idx);
    changedFiles.push(idxPath);
  }

  // 5. Update site.json: add section entry, copy entries, element entries.
  const manifestPath = path.join(site.dir, "site.json");
  const manifest = loadSite(site);

  for (const page of manifest.pages) {
    const srcSection = page.sections.find((s) => s.name === srcName);
    if (!srcSection) continue;

    // New sections[] entry — same role as the source; file = new path; copyKeys renamed.
    const newCopyKeys = srcSection.copyKeys.map((k) =>
      k.replace(new RegExp(`^${srcName}\\.`), `${newName}.`),
    );
    const newSection: ManifestSection = {
      name: newName,
      role: srcSection.role,
      file: `astro/src/components/${newFileName}`,
      copyKeys: newCopyKeys,
      elementRoles: srcSection.elementRoles.map((er) => ({ ...er })),
    };

    // Insert AFTER the afterSection (if provided and found), else at the END — matching
    // index.astro, which appends the new include at the end of the body when afterSection is
    // omitted. Defaulting to "after the source section" here would desync site.json order from
    // the rendered DOM and trip the structural verifier's expectedSectionOrder in the apply loop.
    let insertAfterIdx = page.sections.length - 1;
    if (afterSection) {
      const afterIdx = page.sections.findIndex(
        (s) => s.role === afterSection || s.name === afterSection,
      );
      if (afterIdx !== -1) insertAfterIdx = afterIdx;
    }
    page.sections.splice(insertAfterIdx + 1, 0, newSection);

    // New copy[] entries: clone source entries with renamed keys + component.
    const srcCopyEntries = page.copy.filter((c) => c.component === srcName);
    const newCopyEntries = srcCopyEntries.map((c) => ({
      ...c,
      key: c.key.replace(new RegExp(`^${srcName}\\.`), `${newName}.`),
      component: newName,
    }));
    page.copy.push(...newCopyEntries);

    // New elements[] entries: clone source element entries with renamed component.
    const srcElements = page.elements.filter((e) => e.component === srcName);
    const newElements = srcElements.map((e) => ({
      ...e,
      component: newName,
      selector: `[data-component="${newName}"] [data-role="${e.role}"]`,
    }));
    page.elements.push(...newElements);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  changedFiles.push(manifestPath);

  const op: EditOp = { op: "addSection", cloneOf, ...(afterSection ? { afterSection } : {}) };
  return { op, changedFiles, targetSections: [newName] };
}

// ---------------------------------------------------------------------------
// pickTemplatePage
// ---------------------------------------------------------------------------

/**
 * Auto-pick the best template page from `site.json` for cloning as a new page at `route`.
 *
 * Strategy (route-pattern heuristic):
 *   1. If the route contains a keyword matching a known section role (e.g. "pricing" →
 *      "pricing" role, "about" → "content-block"), prefer a page that has that role.
 *   2. Otherwise, fall back to the page with the most sections (richest template).
 *   3. Ultimately fall back to pages[0] (the home page).
 *
 * This is a PURE function — no file I/O. Unit-testable without a browser.
 */
export function pickTemplatePage(manifest: SiteManifest, route: string): ManifestPage {
  const pages = manifest.pages;
  if (pages.length === 0) throw new Error("pickTemplatePage: site.json has no pages");

  // Route-keyword → section role affinity table.
  const ROUTE_ROLE_MAP: Record<string, string> = {
    pricing: "pricing",
    about: "content-block",
    team: "coach-grid",
    coaches: "coach-grid",
    schedule: "schedule",
    faq: "faq",
    contact: "contact-form",
    testimonials: "testimonials",
    programs: "program-cards",
  };

  const routeLower = route.toLowerCase();
  for (const [keyword, role] of Object.entries(ROUTE_ROLE_MAP)) {
    if (routeLower.includes(keyword)) {
      const match = pages.find((p) => p.sections.some((s) => s.role === role));
      if (match) return match;
    }
  }

  // Fall back: richest page (most sections).
  return pages.reduce((best, p) => (p.sections.length > best.sections.length ? p : best), pages[0]);
}

// ---------------------------------------------------------------------------
// addPage
// ---------------------------------------------------------------------------

/**
 * Add a new page to the projected site at `route` (e.g. "about" → /about/).
 *
 * SCOPE: The projected substrate CAN hold multiple pages — Astro builds any file under
 * src/pages/ as a route. This implementation:
 *   1. Auto-picks a template page via pickTemplatePage (or uses cloneOfPage if given).
 *   2. Copies the template page's components to a page-namespaced set (e.g. AboutNavbar,
 *      AboutHeroSection for the /about page) with rewritten data-component + data-copy refs.
 *   3. Emits `astro/src/pages/<route>.astro` importing the namespaced components.
 *   4. Adds a `site.json.pages[]` entry for the new page.
 *   5. Returns OpResult { changedFiles, targetSections: [names of added components] }.
 *
 * VERIFIER LIMITATION: the verifier's renderSnapshot targets the ROOT page (/) only. The
 * added page cannot be pixel-verified. The correctness guarantee is: build succeeds +
 * dist/<route>/index.html is produced + the root page is structurally unchanged (0-px
 * on all untouched sections). These are checked by the test (not verify()).
 *
 * MULTI-PAGE SUBSTRATE WORK DEFERRED: a full multi-page substrate extension would need:
 *   - verifier support for snapshots at non-root URLs
 *   - per-page copy-key namespace tracking in resolveCopy / resolveSection
 *   - multi-page awareness in all edit ops (they currently assume pages[0])
 * These are T6+ concerns; addPage as shipped is an isolated additive op that keeps pages[0]
 * fully intact.
 */
export function addPage(
  site: SiteRef,
  route: string,
  cloneOfPage?: string,
  pageType?: PageType,
): OpResult {
  // Sanitize route: strip leading/trailing slashes, collapse to alphanumeric-hyphen, trim stray
  // hyphens off the ends. A route that has NO alphanumeric character (empty, or only hyphens like
  // "---") is not a usable page slug — reject it rather than emit an all-hyphen component prefix.
  const cleanRoute = route
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  if (!cleanRoute) throw new Error(`addPage: invalid route "${route}"`);

  const manifest = loadSite(site);

  // Pick the template page.
  let templatePage: ManifestPage;
  if (cloneOfPage) {
    const found = manifest.pages.find(
      (p) => p.route === cloneOfPage || p.component === cloneOfPage,
    );
    if (!found) throw new TargetError(`addPage: cloneOfPage not found in site.json: ${cloneOfPage}`);
    templatePage = found;
  } else {
    templatePage = pickTemplatePage(manifest, route);
  }

  // Namespace prefix for new components: capitalize the route segment (e.g. "about" → "About").
  const prefix = cleanRoute.charAt(0).toUpperCase() + cleanRoute.slice(1);

  const changedFiles: string[] = [];
  const addedSectionNames: string[] = [];
  const componentsDir = path.join(site.dir, "astro", "src", "components");
  fs.mkdirSync(componentsDir, { recursive: true });

  // Build a mapping from old component name → new component name for this page.
  const compMap = new Map<string, string>();
  for (const section of templatePage.sections) {
    compMap.set(section.name, `${prefix}${section.name}`);
  }

  // Copy each component with rewritten refs.
  const newSections: ManifestSection[] = [];
  const newCopyEntries: ManifestCopyEntry[] = [];
  const newElements: ManifestElement[] = [];

  for (const section of templatePage.sections) {
    const srcFile = path.join(site.dir, section.file);
    const newName = compMap.get(section.name)!;
    const newFileName = `${newName}.astro`;
    const newFile = path.join(componentsDir, newFileName);

    if (fs.existsSync(srcFile)) {
      const srcContent = fs.readFileSync(srcFile, "utf8");
      const newContent = rewriteComponentRefs(srcContent, section.name, newName);
      fs.writeFileSync(newFile, newContent);
      changedFiles.push(newFile);
    }

    addedSectionNames.push(newName);

    // New sections[] entry.
    const newCopyKeys = section.copyKeys.map((k) =>
      k.replace(new RegExp(`^${section.name}\\.`), `${newName}.`),
    );
    newSections.push({
      name: newName,
      role: section.role,
      file: `astro/src/components/${newFileName}`,
      copyKeys: newCopyKeys,
      elementRoles: section.elementRoles.map((er) => ({ ...er })),
    });

    // New copy[] entries.
    const srcCopyEntries = templatePage.copy.filter((c) => c.component === section.name);
    for (const c of srcCopyEntries) {
      newCopyEntries.push({
        ...c,
        key: c.key.replace(new RegExp(`^${section.name}\\.`), `${newName}.`),
        component: newName,
      });
    }

    // New elements[] entries.
    const srcElements = templatePage.elements.filter((e) => e.component === section.name);
    for (const e of srcElements) {
      newElements.push({
        ...e,
        component: newName,
        selector: `[data-component="${newName}"] [data-role="${e.role}"]`,
      });
    }
  }

  // Emit the new page's astro/src/pages/<route>.astro.
  const imports = newSections
    .map((s) => `import ${s.name} from "../components/${s.name}.astro";`)
    .join("\n");
  const includes = newSections.map((s) => `<${s.name} />`).join(" ");

  // Classify the new page's type + goal (subsystem D) — must be set before emitting .astro.
  const newRoute = `/${cleanRoute}/`;
  const classified = classifyPage(newRoute);
  const newPageType = pageType ?? classified.type;
  const newPageGoal = GOAL_OF_TYPE[newPageType];

  // Emit a minimal page wrapper with real SEO meta derived from the route.
  // data-page-role + data-goal are render-neutral attributes stamped on <body> (subsystem D).
  const seoMeta = generatePageMeta(newRoute, "", prefix);
  const pageAstroContent =
    `---\nimport "../styles/global.css";\n${imports}\n---\n` +
    `<html lang="en">\n<head>\n<meta charset="utf-8" />\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" />\n` +
    `<title>${seoMeta.title}</title>\n` +
    `<meta name="description" content="${seoMeta.description.replace(/"/g, "&quot;")}" />\n` +
    `<link rel="canonical" href="${seoMeta.canonical}" />\n` +
    `</head>\n` +
    `<body data-page-role="${newPageType}" data-goal="${newPageGoal}">\n${includes}\n</body>\n</html>\n`;

  const pagesDir = path.join(site.dir, "astro", "src", "pages");
  fs.mkdirSync(pagesDir, { recursive: true });
  const pageFile = path.join(pagesDir, `${cleanRoute}.astro`);
  fs.writeFileSync(pageFile, pageAstroContent);
  changedFiles.push(pageFile);

  // Update site.json: add a new ManifestPage entry.
  const newManifestPage: ManifestPage = {
    route: newRoute,
    component: `${prefix}Page`,
    type: newPageType,
    goal: newPageGoal,
    sections: newSections,
    elements: newElements,
    assets: templatePage.assets, // share the same asset pool (same physical files)
    copy: newCopyEntries,
  };
  manifest.pages.push(newManifestPage);
  const manifestPath = path.join(site.dir, "site.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  changedFiles.push(manifestPath);

  const op: EditOp = {
    op: "addPage",
    route,
    ...(cloneOfPage ? { cloneOfPage } : {}),
    ...(pageType ? { pageType } : {}),
  };
  return { op, changedFiles, targetSections: addedSectionNames };
}

/**
 * Add a link to the site's nav component. Idempotent — adding the same href twice is a no-op.
 * Finds the nav section by looking for a section with role "navbar" or name containing "Nav".
 * Inserts a new <li><a href="...">text</a></li> before the closing </ul> tag.
 */
export function addNavLink(
  site: SiteRef,
  text: string,
  href: string,
): OpResult {
  const manifest = loadSite(site);
  const allSections = manifest.pages.flatMap((p) => p.sections);
  const navSection = allSections.find(
    (s) => s.role === "navbar" || /nav/i.test(s.name),
  );
  if (!navSection) throw new TargetError("addNavLink: no nav section found in site.json");

  const navFile = path.join(site.dir, navSection.file);
  if (!fs.existsSync(navFile)) throw new TargetError(`addNavLink: nav file not found: ${navSection.file}`);

  let src = fs.readFileSync(navFile, "utf8");

  // Idempotent — skip if href already in the nav
  if (src.includes(`href="${href}"`)) {
    return { op: { op: "addNavLink" as never, text, href }, changedFiles: [], targetSections: [navSection.name] };
  }

  // Copy the last <li> tag structure as a template, substituting href + text.
  const liMatches = [...src.matchAll(/<li[^>]*>.*?<\/li>/gs)];
  let newLi: string;
  if (liMatches.length > 0) {
    const last = liMatches[liMatches.length - 1][0];
    // Replace the href and text content of the last <li>
    newLi = last
      .replace(/href="[^"]*"/, `href="${href}"`)
      .replace(/>([^<]+)<\/a>/, `>${text}</a>`);
  } else {
    newLi = `<li><a href="${href}">${text}</a></li>`;
  }

  // Insert before </ul>
  const ulEnd = src.indexOf("</ul>");
  if (ulEnd === -1) throw new TargetError("addNavLink: no </ul> found in nav component");
  src = src.slice(0, ulEnd) + newLi + src.slice(ulEnd);
  fs.writeFileSync(navFile, src);

  return { op: { op: "addNavLink" as never, text, href }, changedFiles: [navFile], targetSections: [navSection.name] };
}
