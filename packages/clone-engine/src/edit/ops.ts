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
import type { SiteRef, EditOp, OpResult } from "./types.ts";
import { STYLE_PROPS } from "./types.ts";
import { resolveCopy, resolveAsset, resolveSection, loadSite } from "./target.ts";
import { flattenRoot, canon } from "../brand.ts";
import type { BrandDoc, SiteManifest } from "../types.ts";

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
    for (const [slot, slotObj] of Object.entries(brand.colors) as Array<[string, { value: string; variants: Record<string, string> }]>) {
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
  // Guard: prop must be in the bounded set.
  if (!(STYLE_PROPS as readonly string[]).includes(prop)) {
    throw new Error(`styleTweak: prop '${prop}' not in the bounded set`);
  }

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

  const op: EditOp = { op: "styleTweak", target, prop, value };
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
