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
import type { CaptureJson, TreeNode, TreeEl, Labels } from "./types.ts";
import { esc, escA, diff } from "./html.ts";
import { pixelDiff } from "./pixel.ts";
import { heuristicLabels } from "./labels.ts";
import { buildBrand, brandSlotOfCanon, deriveVariants, flattenRoot } from "./brand.ts";
import { buildManifest } from "./manifest.ts";

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
  const COMP = path.join(OUT, "components");
  const TRIM = opts.trim !== false;
  const BASE = typeof opts.base === "string" ? opts.base.replace(/\/$/, "") : "";
  const linkMap: Record<string, string> = typeof opts.links === "string" ? JSON.parse(fs.readFileSync(path.resolve(opts.links), "utf8")) : {};
  const normUrl = (u: string) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, "") || x.origin; } catch { return u; } };
  const normMap: Record<string, string> = {}; for (const [k, v] of Object.entries(linkMap)) normMap[normUrl(k)] = v;
  const rewriteHref = (h: string) => normMap[normUrl(h)] ?? h;
  fs.mkdirSync(COMP, { recursive: true });

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
      if (keep) { out[k] = v; keptProps++; }
    }
    return out;
  }

  // ---- non-destructive tokenization (colors + fonts) ----
  const COLOR_RE = /rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;
  const canon = (c: string) => { // normalize any color literal to canonical "r,g,b,a" so #EC008C === rgb(236,0,140)
    const s = c.trim().toLowerCase(); let m: RegExpMatchArray | null, r: number, g: number, b: number, a = 1;
    if ((m = s.match(/^#([0-9a-f]{3,8})$/))) { let h = m[1];
      if (h.length === 3) h = h.split("").map((x) => x + x).join("") + "ff";
      else if (h.length === 4) h = h.split("").map((x) => x + x).join("");
      else if (h.length === 6) h = h + "ff";
      r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); a = parseInt(h.slice(6, 8), 16) / 255;
    } else if ((m = s.match(/^rgba?\(([^)]*)\)$/))) { const p = m[1].split(",").map((x) => parseFloat(x)); r = p[0]; g = p[1]; b = p[2]; a = p[3] === undefined ? 1 : p[3]; }
    else return s;
    return `${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(4)}`;
  };
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
  const brandDoc = buildBrand(labels, CAP);
  const reprOfCanon = new Map<string, string>([...colorTok].map(([c, { repr }]) => [c, repr] as const));
  const brandMap = brandSlotOfCanon(labels);        // base canon → --color-<slot>
  const variantMap = deriveVariants(labels, colorTok.keys()); // variant canon → --color-<slot>-<NN>
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
  const tokenRoot = flattenRoot(labels, brandDoc, variantMap, reprOfCanon, [...leftoverColors, ...leftoverFonts]);

  // ---- css: trimmed base + responsive deltas (deltas from full styles) ----
  function cssFor(ids: number[]) {
    let base = "", tab = "", mob = "";
    for (const id of ids) { const b = trimmed(id); if (Object.keys(b).length) base += `.p${id}{${declTok(b)}}\n`; }
    for (const id of ids) { if (S1[id] && S2[id]) { const d = diff(S1[id], S2[id]); if (Object.keys(d).length) tab += `.p${id}{${declTok(d)}}\n`; } }
    for (const id of ids) { if (S2[id] && S3[id]) { const d = diff(S2[id], S3[id]); if (Object.keys(d).length) mob += `.p${id}{${declTok(d)}}\n`; } }
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
  function buildTpl(node: TreeNode, content: string[], base = ""): string {
    const absA2 = (s: string) => s.replace(/(^|[^/])assets\/([af]\d+\.[a-z0-9]+)/g, `$1${base}/assets/$2`);
    if ((node as { t?: string }).t !== undefined) { const i = content.length; content.push((node as { t: string }).t); return "${e(content[" + i + "])}"; }
    const el = node as TreeEl;
    let a = "";
    for (const [k, v] of Object.entries(el.attrs)) a += ` ${k}="${escA(k === "href" ? rewriteHref(v) : v)}"`;
    a += dataAttrs(el.id);
    const open = tplSafe(absA2(`<${el.tag} class="p${el.id}"${a}>`));
    if (VOID.has(el.tag)) return open;
    return open + el.children.map((c) => buildTpl(c, content, base)).join("") + tplSafe(`</${el.tag}>`);
  }

  // ---- partition into components ----
  const elKids = (n: TreeEl) => n.children.filter((c) => (c as { t?: string }).t === undefined) as TreeEl[];
  function findTag(n: TreeEl, t: string): TreeEl | null { if (n.tag === t) return n; for (const c of elKids(n)) { const f = findTag(c, t); if (f) return f; } return null; }
  const main = findTag(CAP.tree, "main") || CAP.tree;
  let sroot = main, sk = elKids(sroot); while (sk.length === 1) { sroot = sk[0]; sk = elKids(sroot); }
  const header = findTag(CAP.tree, "header"), footer = findTag(CAP.tree, "footer");
  const regions: { name: string; node: TreeEl; file?: string }[] = [];
  if (header) regions.push({ name: "Navbar", node: header });
  sk.forEach((s, i) => {
    // Prefer the label-derived name (single source of truth); fall back to copy-derived name.
    let nm: string;
    const labelName = labelNameOfSectionId.get(s.id);
    if (labelName) {
      // Label names already include "Section" suffix (from heuristicLabels); use as-is.
      nm = labelName;
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
    let name = r.name, i = 2; while (seen.has(name)) name = r.name + i++; seen.add(name); r.file = name;
    // region root carries data-component (owning .astro) + data-section (role, for content sections).
    componentNameOfRegionId.set(r.node.id, name);
    fs.writeFileSync(path.join(COMP, `${name}.astro`), `---\n// ${name}.astro — projected from page-clone (LOSSLESS, lean). Imports brand tokens.\nimport "../tokens.css";\nconst content = ${JSON.stringify(copyOf(r.node), null, 2)};\n---\n<style>\n${cssFor(idsOf(r.node))}</style>\n${renderP(r.node)}\n`);
  }
  fs.writeFileSync(path.join(OUT, "tokens.css"), tokenRoot);
  // Editable global brand document (single source of truth for the brand slots).
  fs.writeFileSync(path.join(OUT, "brand.json"), JSON.stringify(brandDoc, null, 2));
  // Agent-addressable site manifest (pure metadata — no render change).
  const manifest = buildManifest({
    base: BASE,
    regions: regions.map((r) => ({
      name: r.name,
      file: r.file!,
      sectionRole: sectionRoleOfRegionId.get(r.node.id) ?? r.name.toLowerCase(),
    })),
    elements: labels.elements,
    assets: labels.assets,
  });
  fs.writeFileSync(path.join(OUT, "site.json"), JSON.stringify(manifest, null, 2));

  // ---- assemble whole page ----
  const head = CAP.head;
  // interactivity: captured menu open-state → CSS behind body[data-pc-open] + a tiny toggle script on the menu button
  const inter = CAP.interactions;
  let interCss = "", interScript = "";
  if (inter && inter.toggles) {
    const scripts: string[] = [];
    for (const t of inter.toggles) {
      for (const id in t.openDelta) interCss += `body[data-pc-open-${t.toggleId}] .p${id}{${declTok(t.openDelta[id])}}\n`;
      scripts.push(`var e${t.toggleId}=document.querySelector('.p${t.toggleId}');if(e${t.toggleId}){e${t.toggleId}.style.cursor='pointer';e${t.toggleId}.addEventListener('click',function(ev){${t.prevent ? "ev.preventDefault();" : ""}ev.stopPropagation();document.body.toggleAttribute('data-pc-open-${t.toggleId}');});}`);
    }
    if (scripts.length) interScript = `<script>(function(){${scripts.join("")}})();</script>`;
  }
  if (inter && inter.hovers) for (const h of inter.hovers) for (const id in h.delta) {
    const sel = id === h.parentId ? `.p${h.parentId}:hover` : `.p${h.parentId}:hover .p${id}`;
    interCss += `${sel}{${declTok(h.delta[id])}}\n`;
  }
  const metaTags = head.metas.map((m) => `<meta ${m.key.startsWith("og:") ? "property" : "name"}="${escA(m.key)}" content="${escA(m.content)}">`).join("\n");
  const iconTags = head.icons.map((ic) => `<link rel="${escA(ic.rel)}" href="${escA(ic.href)}"${ic.sizes ? ` sizes="${escA(ic.sizes)}"` : ""}>`).join("\n");
  const assembled = `<!doctype html><html lang="${escA(head.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(head.title)}</title>
${metaTags}
${iconTags}
<style>html{margin:0;padding:0}${CAP.fontCss || ""}
${tokenRoot}
${cssFor(idsOf(CAP.tree))}
${interCss}</style></head><body class="p${CAP.tree.id}">${CAP.tree.children.map(renderP).join("")}${interScript}</body></html>`;
  fs.writeFileSync(path.join(OUT, "index.html"), assembled);

  // ---- emit a REAL Astro project (components composed + built by the actual compiler) ----
  const AST = path.join(OUT, "astro");
  fs.rmSync(AST, { recursive: true, force: true });
  for (const d of ["src/pages", "src/components", "src/styles", "public/assets"]) fs.mkdirSync(path.join(AST, d), { recursive: true });
  for (const f of fs.readdirSync(path.join(DIR, "assets"))) fs.copyFileSync(path.join(DIR, "assets", f), path.join(AST, "public/assets", f));
  const absA = (s: string) => s.replace(/(^|[^/])assets\/([af]\d+\.[a-z0-9]+)/g, `$1${BASE}/assets/$2`); // scoped to OUR rehosted filenames — won't corrupt foreign URLs containing "assets/"
  fs.writeFileSync(path.join(AST, "src/styles/global.css"), absA(`html{margin:0;padding:0}\n${CAP.fontCss || ""}\n${tokenRoot}\n${cssFor(idsOf(CAP.tree))}\n${interCss}`));
  const regionIds = new Set(regions.map((r) => r.node.id));
  const compOf: Record<number, string> = {}; regions.forEach((r) => (compOf[r.node.id] = r.file!));
  for (const r of regions) {
    const content: string[] = [];
    const tpl = buildTpl(r.node, content, BASE); // text nodes become ${e(content[i])} — edit the array to edit the copy
    fs.writeFileSync(path.join(AST, "src/components", `${r.file}.astro`), `---\nconst content = ${JSON.stringify(content, null, 2)};\nconst e = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));\nconst html = \`${tpl}\`;\n---\n<Fragment set:html={html} />\n`);
  }
  const hasRegion = (n: TreeNode): boolean => (n as { t?: string }).t !== undefined ? false : regionIds.has((n as TreeEl).id) || (n as TreeEl).children.some(hasRegion);
  function pageAstro(n: TreeNode): string {
    if ((n as { t?: string }).t !== undefined) return esc((n as { t: string }).t).replace(/[{}]/g, (m) => (m === "{" ? "&#123;" : "&#125;"));
    const el = n as TreeEl;
    if (regionIds.has(el.id)) return `<${compOf[el.id]} />`;
    if (hasRegion(el)) { let a = ` class="p${el.id}"`; for (const [k, v] of Object.entries(el.attrs)) a += ` ${k}="${escA(k === "href" ? rewriteHref(v) : v)}"`; a += dataAttrs(el.id); return `<${el.tag}${a}>${el.children.map(pageAstro).join("")}</${el.tag}>`; }
    return `<Fragment set:html={${JSON.stringify(absA(renderP(el)))}} />`;
  }
  const imports = regions.map((r) => `import ${r.file} from "../components/${r.file}.astro";`).join("\n");
  fs.writeFileSync(path.join(AST, "src/pages/index.astro"), `---\nimport "../styles/global.css";\n${imports}\n---\n<html lang="${escA(head.lang)}">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width,initial-scale=1" />\n<title>${esc(head.title)}</title>\n<Fragment set:html={${JSON.stringify(absA(metaTags + "\n" + iconTags))}} />\n</head>\n<body class="p${CAP.tree.id}">\n${CAP.tree.children.map(pageAstro).join("")}\n${interScript.replace("<script>", "<script is:inline>")}\n</body>\n</html>\n`);
  fs.writeFileSync(path.join(AST, "package.json"), JSON.stringify({ name: "page-clone-astro", type: "module", private: true, scripts: { build: "astro build" }, dependencies: { astro: "^4.16.0" } }, null, 2));
  fs.writeFileSync(path.join(AST, "astro.config.mjs"), `import { defineConfig } from "astro/config";\nexport default defineConfig(${BASE ? `{ base: "${BASE}" }` : "{}"});\n`);
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
  const sizes = fs.readdirSync(COMP).map((f) => fs.statSync(path.join(COMP, f)).size);
  console.log(`\n  ${regions.length} components, total ${(sizes.reduce((a, b) => a + b, 0) / 1048576).toFixed(2)}MB (largest ${(Math.max(...sizes) / 1024).toFixed(0)}KB)`);

  return { indexHtml: assembled, outDir: OUT, astroDir: AST, components: regions.length };
  } finally {
    await browser.close();
  }
}
