/**
 * B milestone + CSS TRIM — project the whole page into LEAN editable components
 * (only non-default CSS per element) and PROVE lossless by diffing the
 * assembled-from-components page vs the static clone at desktop AND mobile.
 *
 * Trim rule (safe): inherited prop kept iff != parent's value; non-inherited prop
 * kept iff != that tag's UA default (computed empirically). Oracle re-diff is the gate.
 *
 * Ported byte-faithfully from page-clone-spike/project-page.mjs — same algorithm,
 * same output. Only mechanical changes: CLI args → opts, top-level body → function.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import type { CaptureJson, TreeNode, TreeEl, Labels, ManifestCopyEntry } from "./types.ts";
import { esc, escA, diff } from "./html.ts";
import { canon, COLOR_RE, findTag as findTagIn, partitionRegions, dropRedundantLogical } from "./tree.ts";
import { pixelDiff } from "./pixel.ts";
import { heuristicLabels } from "./labels.ts";
import { buildBrand, brandSlotOfCanon, deriveVariants, flattenRoot } from "./brand.ts";
import { buildManifest } from "./manifest.ts";
import { classifyPage } from "./pagemodel.ts";

export interface ProjectOpts {
  dir: string;
  out?: string;
  base?: string;
  links?: string;
  trim?: boolean;
  noDiff?: boolean;
}
export interface ProjectResult {
  indexHtml: string;
  outDir: string;
  astroDir: string;
  components: number;
}

export async function project(opts: ProjectOpts): Promise<ProjectResult> {
  const DIR = path.resolve(opts.dir);
  const CAP: CaptureJson = JSON.parse(fs.readFileSync(path.join(DIR, "capture.json"), "utf8"));
  // kill FOUT: source uses font-display:swap (fallback → swap = visible flicker). block paints the correct font once ready (self-hosted → instant).
  CAP.fontCss = (CAP.fontCss || "").replace(/font-display\s*:\s*[a-z-]+/gi, "font-display:block");
  const OUT = path.resolve(opts.out ?? "out-project-page");
  const TRIM = opts.trim !== false;
  const BASE = typeof opts.base === "string" ? opts.base.replace(/\/$/, "") : "";
  const linkMap: Record<string, string> = typeof opts.links === "string" ? JSON.parse(fs.readFileSync(path.resolve(opts.links), "utf8")) : {};
  const normUrl = (u: string) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, "") || x.origin; } catch { return u; } };
  const normMap: Record<string, string> = {}; for (const [k, v] of Object.entries(linkMap)) normMap[normUrl(k)] = v;
  // Source origins from the capture (e.g. ["https://www.torrancetraininglab.com"]).
  // Internal absolute links that point back to the source domain are rewritten to root-relative
  // paths so they work on the cloned domain without pointing back to the original site.
  const srcOrigins = (CAP.sourceOrigins ?? []).map((o: string) => o.replace(/\/+$/, ""));
  const rewriteHref = (h: string) => {
    if (normMap[normUrl(h)]) return normMap[normUrl(h)];
    // Rewrite absolute internal link → root-relative path (strips source origin)
    for (const origin of srcOrigins) {
      if (h.startsWith(origin + "/") || h === origin) return h.slice(origin.length) || "/";
    }
    return h;
  };
  fs.mkdirSync(OUT, { recursive: true });

  const VOID = new Set(["img", "br", "hr", "input", "source", "use", "path", "circle", "rect", "line", "polygon", "polyline", "ellipse", "col", "area"]);
  const SVG = new Set(["svg", "path", "g", "circle", "rect", "line", "polygon", "polyline", "ellipse", "use", "defs", "text", "tspan", "clippath", "lineargradient", "radialgradient", "stop", "mask", "symbol", "marker", "pattern", "filter", "image"]);
  const ALWAYS_KEEP = new Set(["text-decoration", "text-decoration-line", "text-decoration-color", "text-decoration-style", "text-decoration-thickness",
    // never trim core font properties — losing weight/style/family is unacceptable and they're cheap (few per element)
    "font-weight", "font-style", "font-family", "font-stretch", "font-variation-settings", "font-size", "line-height"]);
  const INHERITED = new Set(["color", "cursor", "direction", "font-family", "font-size", "font-style", "font-variant", "font-weight", "font-stretch", "letter-spacing", "line-height", "list-style-image", "list-style-position", "list-style-type", "quotes", "tab-size", "text-align", "text-align-last", "text-indent", "text-transform", "visibility", "white-space", "white-space-collapse", "word-break", "word-spacing", "overflow-wrap", "writing-mode", "hyphens", "text-shadow", "caption-side", "border-collapse", "border-spacing", "empty-cells", "-webkit-font-smoothing", "-webkit-text-fill-color", "text-rendering", "orphans", "widows", "pointer-events", "color-scheme", "font-kerning", "font-feature-settings", "font-optical-sizing"]);
  const S1 = CAP.styles["1440"], S2 = CAP.styles["768"], S3 = CAP.styles["390"];

  // ---- tree maps: tag + parent per id ----
  const tagOf: Record<number, string> = {}, parentOf: Record<number, number | null> = {};
  (function walk(n: TreeNode, par: number | null) { if ((n as { t?: string }).t !== undefined) return; const el = n as TreeEl; tagOf[el.id] = el.tag; parentOf[el.id] = par; el.children.forEach((c) => walk(c, el.id)); })(CAP.tree, null);
  const distinctTags = [...new Set(Object.values(tagOf))].filter((t) => !SVG.has(t));

  // ---- semantic labels: consume labels.json (or compute deterministic heuristics) ----
  // data-* stamping is render-neutral (attributes only), so the 0-px oracle must hold.
  const labelsPath = path.join(DIR, "labels.json");
  const labels: Labels = fs.existsSync(labelsPath)
    ? (JSON.parse(fs.readFileSync(labelsPath, "utf8")) as Labels)
    : heuristicLabels(CAP);
  // element id → role (headline, primary-cta, logo, …)
  const roleOfElId = new Map<number, string>(labels.elements.map((e) => [e.id, e.role] as const));
  // element id → asset alias, matched by the element's src/srcset/background referencing an asset file.
  // Assets carry a file (assets/aN.ext) + alias; find every element whose captured attrs reference it.
  const aliasOfElId = new Map<number, string>();
  if (labels.assets.length) {
    const aliasByFile = new Map(labels.assets.map((a) => [a.file, a.alias] as const));
    (function scan(n: TreeNode) {
      if ((n as { t?: string }).t !== undefined) return;
      const el = n as TreeEl;
      // scan value-bearing attrs for any labeled asset file (src, srcset, poster, style-bg, etc.)
      const hay = Object.entries(el.attrs)
        .filter(([k]) => k === "src" || k === "srcset" || k === "poster" || k === "href" || k === "style" || k === "data-src")
        .map(([, v]) => v)
        .join(" ");
      if (hay) for (const [file, alias] of aliasByFile) if (hay.includes(file)) { aliasOfElId.set(el.id, alias); break; }
      el.children.forEach(scan);
    })(CAP.tree);
  }
  // region-root id → { section role, component name }; populated once regions are partitioned below.
  const sectionRoleOfRegionId = new Map<number, string>(labels.sections.map((s) => [s.id, s.role] as const));
  // region-root id → label-derived name (single source of truth for component names).
  const labelNameOfSectionId = new Map<number, string>(
    labels.sections.filter((s) => s.name && s.name !== "unknown").map((s) => [s.id, s.name] as const),
  );
  const componentNameOfRegionId = new Map<number, string>();
  // Emit the additive data-* attribute string for an element (empty when nothing to stamp).
  // ORDER: element role/asset first, then section/component on region roots — always AFTER existing attrs.
  const dataAttrs = (id: number): string => {
    let a = "";
    const role = roleOfElId.get(id);
    if (role) a += ` data-role="${escA(role)}"`;
    const alias = aliasOfElId.get(id);
    if (alias) a += ` data-asset="${escA(alias)}"`;
    const sectionRole = sectionRoleOfRegionId.get(id);
    if (sectionRole) a += ` data-section="${escA(sectionRole)}"`;
    const component = componentNameOfRegionId.get(id);
    if (component) a += ` data-component="${escA(component)}"`;
    return a;
  };

  // ---- browser: empirical UA defaults per tag ----
  const browser = await chromium.launch();
  // Guarantee the Chromium process is torn down even if projection throws
  // (the source .mjs leaks it on error; we improve on that, output-neutral).
  try {
  const defPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await defPage.setContent("<!doctype html><body></body>");
  const tagDefaults: Record<string, Record<string, string>> = await defPage.evaluate((tags) => {
    const out: Record<string, Record<string, string>> = {}; const holder = document.createElement("div"); document.body.appendChild(holder);
    for (const t of tags) { try { const el = document.createElement(t); if (t === "a") el.setAttribute("href", "#"); holder.appendChild(el); const cs = getComputedStyle(el); const m: Record<string, string> = {}; for (const p of cs) m[p] = cs.getPropertyValue(p); out[t] = m; holder.removeChild(el); } catch { /* ignore invalid tag */ } }
    document.body.removeChild(holder); return out;
  }, distinctTags);
  await defPage.close();

  // ---- trim one element's desktop style ----
  let keptProps = 0, fullProps = 0;
  function trimmed(id: number): Record<string, string> {
    const full = S1[id]; if (!full) return {};
    if (!TRIM) { const c = { ...full }; fullProps += Object.keys(full).length; keptProps += Object.keys(full).length; return c; }
    const def = SVG.has(tagOf[id]) ? null : tagDefaults[tagOf[id]];
    const par = parentOf[id] != null ? S1[parentOf[id] as number] : null;
    // coupled props: a styled border/outline with an omitted width defaults to 'medium', not 0 —
    // so keep width+style+color together on any side whose style isn't 'none'.
    const forceKeep = new Set<string>();
    for (const side of ["top", "right", "bottom", "left"]) if (full[`border-${side}-style`] && full[`border-${side}-style`] !== "none") for (const p of ["width", "style", "color"]) forceKeep.add(`border-${side}-${p}`);
    if (full["outline-style"] && full["outline-style"] !== "none") for (const p of ["outline-width", "outline-style", "outline-color"]) forceKeep.add(p);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(full)) {
      fullProps++;
      const keep = ALWAYS_KEEP.has(k) || forceKeep.has(k) ? true : INHERITED.has(k) ? (!par || par[k] !== v) : (!def || def[k] !== v);
      if (keep) out[k] = v;
    }
    // Byte-safe dedup: drop logical props equal to their physical twin (see tree.ts).
    const deduped = dropRedundantLogical(out);
    keptProps += Object.keys(deduped).length;
    return deduped;
  }

  // ---- non-destructive tokenization (colors + fonts) ----
  // COLOR_RE + canon come from tree.ts (shared, byte-identical to the former inline copies).
  const colorName = (key: string) => { // legible + unique token name from a canonical color: hue/tone + hex
    const [r, g, b, a] = key.split(",").map(Number);
    const hex = [r, g, b].map((n) => (n & 255).toString(16).padStart(2, "0")).join("");
    if (a === 0) return `transparent-${hex}`;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510;
    let base: string;
    if (mx - mn < 12) base = l > 0.92 ? "white" : l < 0.08 ? "black" : l < 0.3 ? "ink" : "gray";
    else { const rr = r / 255, gg = g / 255, bb = b / 255, m2 = Math.max(rr, gg, bb), n2 = Math.min(rr, gg, bb), d = m2 - n2; let h = m2 === rr ? ((gg - bb) / d) % 6 : m2 === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4; h = Math.round(h * 60); if (h < 0) h += 360; base = ([[15, "red"], [45, "orange"], [70, "yellow"], [95, "lime"], [150, "green"], [185, "teal"], [210, "cyan"], [250, "blue"], [278, "indigo"], [300, "violet"], [335, "magenta"], [361, "pink"]] as [number, string][]).find(([d2]) => h <= d2)![1]; }
    return `${base}-${hex}${a < 1 ? `-a${Math.round(a * 100)}` : ""}`;
  };
  const slug = (s: string) => s.split(",")[0].replace(/["']/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "font";
  const colorTok = new Map<string, { token: string; repr: string }>(), fontTok = new Map<string, string>(); const fontSeen = new Set<string>(); // canon-key -> {token, repr}
  for (const S of [S1, S2, S3]) for (const id in S) for (const [k, v] of Object.entries(S[id])) {
    for (const m of v.matchAll(COLOR_RE)) { const key = canon(m[0]); if (!colorTok.has(key)) colorTok.set(key, { token: `--${colorName(key)}`, repr: m[0] }); }
    if (k === "font-family" && !fontTok.has(v)) { let n = `--font-${slug(v)}`; if (fontSeen.has(n)) { let i = 2; while (fontSeen.has(`${n}-${i}`)) i++; n = `${n}-${i}`; } fontSeen.add(n); fontTok.set(v, n); }
  }
  // ---- canonical BRAND cascade (Plan 2, Task 3) ----
  // Rename the tokens that correspond to a labeled brand SLOT to canonical `--color-<slot>`
  // (+ opacity/tint variants → `--color-<slot>-<NN>`) and emit an editable `brand.json`.
  // BYTE-PRESERVING: a canonical var's value = the EXACT captured literal (repr) of its canon,
  // and a literal is only rewritten to a canonical var if its canon equals the slot/variant
  // canon — so it resolves to identical bytes. Non-brand colors keep their per-literal token.
  const reprOfCanon = new Map<string, string>([...colorTok].map(([c, { repr }]) => [c, repr] as const));
  const brandMap = brandSlotOfCanon(labels);        // base canon → --color-<slot>
  const variantMap = deriveVariants(labels, colorTok.keys()); // variant canon → --color-<slot>-<NN>
  // brand.json IS the source of the canonical :root: buildBrand seeds every slot's value +
  // variants from the EXACT captured reprs (alpha preserved), and flattenRoot emits :root from
  // it — so editing brand.json recolors the site, and first emit is byte-identical (0-px).
  const brandDoc = buildBrand(labels, reprOfCanon, variantMap);
  // canon → canonical var name (base slot wins over variant; both preferred over per-literal token)
  const canonicalName = new Map<string, string>([...variantMap, ...brandMap]);
  // Brand fonts: map the exact display/body family strings to --font-display/--font-body.
  const canonicalFont = new Map<string, string>();
  for (const f of labels.brand.fonts) if (f.slot === "display" || f.slot === "body") canonicalFont.set(f.family, `--font-${f.slot}`);

  const tok = (k: string, v: string) => {
    let o = v.replace(COLOR_RE, (m) => {
      const key = canon(m);
      const cn = canonicalName.get(key);
      if (cn) return `var(${cn})`;
      const t = colorTok.get(key);
      return t ? `var(${t.token})` : m;
    });
    if (k === "font-family") {
      if (canonicalFont.has(v)) o = `var(${canonicalFont.get(v)})`;
      else if (fontTok.has(v)) o = `var(${fontTok.get(v)})`;
    }
    return o;
  };
  const declTok = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k}:${tok(k, v)}`).join(";");
  // :root = canonical brand cascade + leftover per-literal color tokens (non-brand) + leftover
  // font tokens (families not promoted to a canonical --font-<slot>) — ALL in one valid rule.
  const leftoverColors = [...colorTok].filter(([c]) => !canonicalName.has(c)).map(([, { token, repr }]) => `  ${token}: ${repr};`);
  const leftoverFonts = [...fontTok].filter(([f]) => !canonicalFont.has(f)).map(([f, t]) => `  ${t}: ${f};`);
  const tokenRoot = flattenRoot(brandDoc, [...leftoverColors, ...leftoverFonts]);

  // ---- css: trimmed base + responsive deltas (deltas from full styles) ----
  function cssFor(ids: number[]) {
    let base = "", tab = "", mob = "";
    for (const id of ids) { const b = trimmed(id); if (Object.keys(b).length) base += `.p${id}{${declTok(b)}}\n`; }
    for (const id of ids) { if (S1[id] && S2[id]) { const d = dropRedundantLogical(diff(S1[id], S2[id])); if (Object.keys(d).length) tab += `.p${id}{${declTok(d)}}\n`; } }
    for (const id of ids) { if (S2[id] && S3[id]) { const d = dropRedundantLogical(diff(S2[id], S3[id])); if (Object.keys(d).length) mob += `.p${id}{${declTok(d)}}\n`; } }
    return `${base}\n@media(max-width:768px){\n${tab}}\n@media(max-width:480px){\n${mob}}\n`;
  }
  function idsOf(n: TreeNode, a: number[] = []): number[] { if ((n as { t?: string }).t !== undefined) return a; const el = n as TreeEl; a.push(el.id); el.children.forEach((c) => idsOf(c, a)); return a; }
  function copyOf(n: TreeNode, a: string[] = []): string[] { if ((n as { t?: string }).t !== undefined) { const tn = n as { t: string }; if (tn.t.trim()) a.push(tn.t); return a; } (n as TreeEl).children.forEach((c) => copyOf(c, a)); return a; }
  function renderP(n: TreeNode): string {
    if ((n as { t?: string }).t !== undefined) return esc((n as { t: string }).t);
    const el = n as TreeEl;
    let a = ` class="p${el.id}"`;
    for (const [k, v] of Object.entries(el.attrs)) a += ` ${k}="${escA(k === "href" ? rewriteHref(v) : v)}"`;
    a += dataAttrs(el.id);
    if (VOID.has(el.tag)) return `<${el.tag}${a}>`;
    return `<${el.tag}${a}>${el.children.map(renderP).join("")}</${el.tag}>`;
  }
  // build a template-literal body whose text nodes interpolate from an editable `content` array
  const tplSafe = (s: string) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  // copyEntries: accumulates {key, component, index} as buildTpl processes each region.
  // Reset per-region by the caller (passed as a fresh array each time).
  // key format: "<ComponentName>.<contentIndex>" — stable across re-projections of the same capture.
  function buildTpl(node: TreeNode, content: string[], base: string, compName: string, copyEntries: ManifestCopyEntry[]): string {
    const absA2 = (s: string) => s.replace(/(^|[^/])assets\/([af]\d+\.[a-z0-9]+)/g, `$1${base}/assets/$2`);
    if ((node as { t?: string }).t !== undefined) { const i = content.length; content.push((node as { t: string }).t); return "${e(content[" + i + "])}"; }
    const el = node as TreeEl;
    // Collect indices for text nodes that are DIRECT children of this element (not descendants).
    // These are the indices each text child will occupy in content[] when processed in order.
    // We scan ahead to know the keys BEFORE recursing, so we can stamp data-copy on this element.
    // Pure-whitespace/empty slots stay in content[] (render fidelity) but are NOT addressable
    // copy — we skip them for both the copy[] map and the data-copy attribute.
    const directText: Array<{ idx: number; text: string }> = [];
    let nextIdx = content.length;
    for (const child of el.children) {
      if ((child as { t?: string }).t !== undefined) {
        directText.push({ idx: nextIdx++, text: (child as { t: string }).t });
      } else {
        // non-text child: count how many text nodes (at any depth) it contributes to content[]
        // so our nextIdx tracking stays in sync. We do a quick pre-count pass.
        (function countTexts(n: TreeNode): void {
          if ((n as { t?: string }).t !== undefined) { nextIdx++; return; }
          (n as TreeEl).children.forEach(countTexts);
        })(child);
      }
    }
    // Only real (non-whitespace) text slots are addressable copy.
    const addressable = directText.filter((d) => d.text.trim().length > 0);
    const role = roleOfElId.get(el.id);
    const copyKeys = addressable.map((d) => `${compName}.${d.idx}`);
    for (const d of addressable) {
      const preview = d.text.trim().replace(/\s+/g, " ").slice(0, 60);
      copyEntries.push({ key: `${compName}.${d.idx}`, component: compName, index: d.idx, text: preview, ...(role ? { role } : {}) });
    }
    const dataCopy = copyKeys.length ? ` data-copy="${escA(copyKeys.join(" "))}"` : "";
    let a = "";
    for (const [k, v] of Object.entries(el.attrs)) a += ` ${k}="${escA(k === "href" ? rewriteHref(v) : v)}"`;
    a += dataAttrs(el.id);
    a += dataCopy;
    const open = tplSafe(absA2(`<${el.tag} class="p${el.id}"${a}>`));
    if (VOID.has(el.tag)) return open;
    return open + el.children.map((c) => buildTpl(c, content, base, compName, copyEntries)).join("") + tplSafe(`</${el.tag}>`);
  }

  // ---- partition into components ----
  // Region descent (main → single-child unwrap → top-level regions) is the shared
  // partitionRegions from tree.ts — byte-identical to the former inline copy here and
  // to the one labels.ts consumes, so section ids/order match the labeler exactly.
  const sk = partitionRegions(CAP.tree).map((r) => r.node);
  const header = findTagIn(CAP.tree, "header"), footer = findTagIn(CAP.tree, "footer");
  const regions: { name: string; node: TreeEl; file?: string }[] = [];
  if (header) regions.push({ name: "Navbar", node: header });
  sk.forEach((s, i) => {
    // Prefer the label-derived name (single source of truth); fall back to copy-derived name.
    let nm: string;
    const labelName = labelNameOfSectionId.get(s.id);
    if (labelName) {
      // Sanitize to a valid PascalCase JS identifier. Heuristic labels are already valid
      // (this is a no-op for them), but LLM labels are human-readable ("Header Navigation",
      // "FAQ Section") and would otherwise be emitted verbatim as `import Header Navigation`
      // — a syntax error that breaks the entire page's astro build.
      nm = labelName
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("");
      if (!nm) nm = `Section${i}`;
      if (/^[0-9]/.test(nm)) nm = "S" + nm;
    } else {
      // Existing copy-derived fallback (unchanged algorithm).
      const cp = copyOf(s);
      const h = cp.find((t) => t.trim().length > 5) || `Section ${i}`;
      let base = h.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("").slice(0, 24) || `Section${i}`;
      if (/^[0-9]/.test(base)) base = "S" + base;
      nm = base + "Section";
    }
    regions.push({ name: nm, node: s });
  });
  if (footer) regions.push({ name: "Footer", node: footer });

  const seen = new Set<string>();
  for (const r of regions) {
    let name = r.name, i = 2; while (seen.has(name)) name = r.name + i++; seen.add(name); r.name = name; r.file = name;
    // region root carries data-component (owning .astro) + data-section (role, for content sections).
    componentNameOfRegionId.set(r.node.id, name);
  }
  fs.writeFileSync(path.join(OUT, "tokens.css"), tokenRoot);
  // copy[] is populated during the Astro region loop (buildTpl) below; manifest is written after.
  // (The real editable component tree lives in astro/src/components — emitted below. There is
  // no separate OUT/components tree: it was a dead renderP-based copy with no data-copy wiring.)

  // ---- assemble whole page ----
  const head = CAP.head;
  // interactivity: captured menu open-state → CSS behind body[data-pc-open] + a tiny toggle script on the menu button
  const inter = CAP.interactions;
  let interCss = "", interScript = "";
  // Slim an open-state delta the same way the base CSS is slimmed: an open-state rule only
  // needs the props that actually CHANGE from the closed (base) state. So drop (a) logical
  // props equal to their physical twin, (b) trivial `min-*:auto`, and (c) any prop whose
  // value equals the element's closed-state computed value (S1[id]) — re-emitting it is a
  // no-op. Every prop that genuinely differs on open is preserved, so the open menu still
  // renders correctly.
  const trimOpenDelta = (id: number, delta: Record<string, string>): Record<string, string> => {
    const base = S1[id];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(delta)) {
      if (k.startsWith("min-") && v === "auto") continue;          // UA default no-op
      if (base && base[k] === v) continue;                          // equals closed state → not a delta
      out[k] = v;
    }
    return dropRedundantLogical(out);                               // logical==physical dedup
  };
  if (inter && inter.toggles) {
    const scripts: string[] = [];
    for (const t of inter.toggles) {
      for (const id in t.openDelta) {
        const d = trimOpenDelta(Number(id), t.openDelta[id]);
        if (Object.keys(d).length) interCss += `body[data-pc-open-${t.toggleId}] .p${id}{${declTok(d)}}\n`;
      }
      scripts.push(`var e${t.toggleId}=document.querySelector('.p${t.toggleId}');if(e${t.toggleId}){e${t.toggleId}.style.cursor='pointer';e${t.toggleId}.addEventListener('click',function(ev){${t.prevent ? "ev.preventDefault();" : ""}ev.stopPropagation();document.body.toggleAttribute('data-pc-open-${t.toggleId}');});}`);
    }
    if (scripts.length) interScript = `<script>(function(){${scripts.join("")}})();</script>`;
  }
  if (inter && inter.hovers) for (const h of inter.hovers) for (const id in h.delta) {
    const sel = id === h.parentId ? `.p${h.parentId}:hover` : `.p${h.parentId}:hover .p${id}`;
    const d = dropRedundantLogical(h.delta[id]);
    if (Object.keys(d).length) interCss += `${sel}{${declTok(d)}}\n`;
  }
  // ---- page model (subsystem D): classify route → type + goal data-attrs on <body> ----
  // data-page-role + data-goal are render-neutral (attributes only) → 0-px oracle must hold.
  const pageRoute = BASE ? `${BASE}/` : "/";
  const { type: pageType, goal: pageGoal } = classifyPage(pageRoute);
  const bodyPageAttrs = ` data-page-role="${escA(pageType)}" data-goal="${escA(pageGoal)}"`;

  const metaTags = head.metas.map((m) => `<meta ${m.key.startsWith("og:") ? "property" : "name"}="${escA(m.key)}" content="${escA(m.content)}">`).join("\n");
  const iconTags = head.icons.map((ic) => `<link rel="${escA(ic.rel)}" href="${escA(ic.href)}"${ic.sizes ? ` sizes="${escA(ic.sizes)}"` : ""}>`).join("\n");
  const assembled = `<!doctype html><html lang="${escA(head.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(head.title)}</title>
${metaTags}
${iconTags}
<style>html{margin:0;padding:0}${CAP.fontCss || ""}
${tokenRoot}
${cssFor(idsOf(CAP.tree))}
${interCss}</style></head><body class="p${CAP.tree.id}"${bodyPageAttrs}>${CAP.tree.children.map(renderP).join("")}${interScript}</body></html>`;
  fs.writeFileSync(path.join(OUT, "index.html"), assembled);

  // ---- emit a REAL Astro project (components composed + built by the actual compiler) ----
  const AST = path.join(OUT, "astro");
  fs.rmSync(AST, { recursive: true, force: true });
  for (const d of ["src/pages", "src/components", "src/styles", "public/assets"]) fs.mkdirSync(path.join(AST, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(DIR, "assets"))) fs.copyFileSync(path.join(DIR, "assets", f), path.join(AST, "public/assets", f));
  const absA = (s: string) => s.replace(/(^|[^/])assets\/([af]\d+\.[a-z0-9]+)/g, `$1${BASE}/assets/$2`); // scoped to OUR rehosted filenames — won't corrupt foreign URLs containing "assets/"
  fs.writeFileSync(path.join(AST, "src/styles/global.css"), absA(`html{margin:0;padding:0}\n${CAP.fontCss || ""}\n${tokenRoot}\n${cssFor(idsOf(CAP.tree))}\n${interCss}`));
  // brand.json ships INSIDE the astro project (part of the editable artifact) and IS the
  // source of the canonical :root — flattenRoot(brandDoc) above already produced the emitted
  // tokens from it, so editing brand.json + re-projecting recolors the site.
  fs.writeFileSync(path.join(AST, "brand.json"), JSON.stringify(brandDoc, null, 2));
  const regionIds = new Set(regions.map((r) => r.node.id));
  const compOf: Record<number, string> = {}; regions.forEach((r) => (compOf[r.node.id] = r.file!));
  // element id → owning component: walk each region subtree, tag every element with its region's file.
  const componentOfElId = new Map<number, string>();
  for (const r of regions) (function tag(n: TreeNode): void {
    if ((n as { t?: string }).t !== undefined) return;
    const el = n as TreeEl; componentOfElId.set(el.id, r.file!); el.children.forEach(tag);
  })(r.node);
  // allCopyEntries: all data-copy key → content[] slot mappings across every region.
  const allCopyEntries: ManifestCopyEntry[] = [];
  for (const r of regions) {
    const content: string[] = [];
    const regionCopyEntries: ManifestCopyEntry[] = [];
    const tpl = buildTpl(r.node, content, BASE, r.file!, regionCopyEntries); // text nodes become ${e(content[i])} with data-copy keys
    allCopyEntries.push(...regionCopyEntries);
    fs.writeFileSync(path.join(AST, "src/components", `${r.file}.astro`), `---\nconst content = ${JSON.stringify(content, null, 2)};\nconst e = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));\nconst html = \`${tpl}\`;\n---\n<Fragment set:html={html} />\n`);
  }
  // Agent-addressable site manifest (pure metadata — no render change).
  // Written after buildTpl so it includes the complete copy[] map.
  const manifest = buildManifest({
    base: BASE,
    pageType,
    pageGoal,
    regions: regions.map((r) => ({
      name: r.name,
      file: r.file!,
      sectionRole: sectionRoleOfRegionId.get(r.node.id) ?? r.name.toLowerCase(),
    })),
    elements: labels.elements.map((e) => ({ ...e, component: componentOfElId.get(e.id) })),
    assets: labels.assets,
    copy: allCopyEntries,
  });
  fs.writeFileSync(path.join(OUT, "site.json"), JSON.stringify(manifest, null, 2));
  const hasRegion = (n: TreeNode): boolean => (n as { t?: string }).t !== undefined ? false : regionIds.has((n as TreeEl).id) || (n as TreeEl).children.some(hasRegion);
  function pageAstro(n: TreeNode): string {
    if ((n as { t?: string }).t !== undefined) return esc((n as { t: string }).t).replace(/[{}]/g, (m) => (m === "{" ? "&#123;" : "&#125;"));
    const el = n as TreeEl;
    if (regionIds.has(el.id)) return `<${compOf[el.id]} />`;
    if (hasRegion(el)) { let a = ` class="p${el.id}"`; for (const [k, v] of Object.entries(el.attrs)) a += ` ${k}="${escA(k === "href" ? rewriteHref(v) : v)}"`; a += dataAttrs(el.id); return `<${el.tag}${a}>${el.children.map(pageAstro).join("")}</${el.tag}>`; }
    return `<Fragment set:html={${JSON.stringify(absA(renderP(el)))}} />`;
  }
  const imports = regions.map((r) => `import ${r.file} from "../components/${r.file}.astro";`).join("\n");
  fs.writeFileSync(path.join(AST, "src/pages/index.astro"), `---\nimport "../styles/global.css";\n${imports}\n---\n<html lang="${escA(head.lang)}">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width,initial-scale=1" />\n<title>${esc(head.title)}</title>\n<Fragment set:html={${JSON.stringify(absA(metaTags + "\n" + iconTags))}} />\n</head>\n<body class="p${CAP.tree.id}"${bodyPageAttrs}>\n${CAP.tree.children.map(pageAstro).join("")}\n${interScript.replace("<script>", "<script is:inline>")}\n</body>\n</html>\n`);
  fs.writeFileSync(path.join(AST, "package.json"), JSON.stringify({ name: "page-clone-astro", type: "module", private: true, scripts: { build: "astro build" }, dependencies: { astro: "^4.16.0" } }, null, 2));
  // vite.cacheDir is set to a per-project ".vite" (project root, NOT node_modules)
  // so concurrent builds don't share Vite's dep-optimizer cache. The astro build
  // symlinks node_modules to one shared install, and Vite's default cache lives at
  // node_modules/.vite — i.e. shared across all parallel builds through that symlink,
  // a write race. Redirecting cacheDir out of node_modules isolates each build.
  const cfgBody = BASE ? `{ base: "${BASE}", vite: { cacheDir: ".vite" } }` : `{ vite: { cacheDir: ".vite" } }`;
  fs.writeFileSync(path.join(AST, "astro.config.mjs"), `import { defineConfig } from "astro/config";\nexport default defineConfig(${cfgBody});\n`);
  console.log(`  emitted real Astro project → ${AST} (${regions.length} components)`);

  // ---- diff assembled vs static clone ----
  async function shoot(file: string, name: string, w: number) {
    const p = await browser.newPage({ viewport: { width: w, height: 900 } });
    await p.route("**/*", (route) => { const u = route.request().url(); if (u.includes("/assets/")) { const rel = decodeURIComponent(u.split("/assets/")[1].split("?")[0]); return route.fulfill({ path: path.join(DIR, "assets", rel) }).catch(() => route.abort()); } return route.continue(); });
    await p.goto("file://" + file, { waitUntil: "networkidle" });
    await p.evaluate(async () => { if (document.fonts) await document.fonts.ready; window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 300)); window.scrollTo(0, 0); });
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUT, name), fullPage: true }); await p.close();
  }
  // strip-diff two on-disk PNGs (in OUT) via the shared oracle — same fn the parity test uses.
  const pdiff = (a: string, b: string) => pixelDiff(browser, fs.readFileSync(path.join(OUT, a)), fs.readFileSync(path.join(OUT, b)));
  console.log(`trim: ${TRIM ? "ON" : "off"} — kept ${keptProps}/${fullProps} props (${(100 - keptProps / fullProps * 100).toFixed(1)}% dropped)`);
  if (!opts.noDiff) for (const w of [1440, 390]) {
    await shoot(path.join(DIR, "index.html"), `clone-${w}.png`, w);
    await shoot(path.join(OUT, "index.html"), `assembled-${w}.png`, w);
    const r = await pdiff(`clone-${w}.png`, `assembled-${w}.png`);
    console.log(`  @${w}w  drift ${r.pct}%  (${r.d}/${r.total})  dims ${r.dimMatch ? "match" : `MISMATCH ${r.ah}/${r.bh}`}  ${r.pct === 0 ? "✓ LOSSLESS" : "✗"}`);
  }
  const compDir = path.join(AST, "src/components");
  const sizes = fs.readdirSync(compDir).map((f) => fs.statSync(path.join(compDir, f)).size);
  console.log(`\n  ${regions.length} components, total ${(sizes.reduce((a, b) => a + b, 0) / 1048576).toFixed(2)}MB (largest ${(Math.max(...sizes) / 1024).toFixed(0)}KB)`);

  return { indexHtml: assembled, outDir: OUT, astroDir: AST, components: regions.length };
  } finally {
    await browser.close();
  }
}
