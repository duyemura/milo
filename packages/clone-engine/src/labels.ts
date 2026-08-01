/**
 * labels.ts — semantic labeling pass (Plan 2, Task 0)
 *
 * Reads capture.json → Labels (heuristic, deterministic, no LLM).
 * The LLM path slots into the async `label()` entry-point later without signature change.
 *
 * Key guarantee: same capture.json → byte-identical labels.json every run (no Date, no Math.random).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  CaptureJson, TreeEl, TreeNode, StyleMap,
} from "./types.ts";
import {
  SECTION_ROLES, BRAND_COLOR_SLOTS, BRAND_FONT_SLOTS,
} from "./types.ts";
import type { Labels } from "./types.ts";

// ---- Zod schema (validates the Labels shape; also used by the future LLM path) ----

export const LabelSchema = z.object({
  site: z.object({ name: z.string(), purpose: z.string() }),
  brand: z.object({
    colors: z.array(z.object({
      slot: z.enum(BRAND_COLOR_SLOTS),
      canon: z.string(),
    })),
    fonts: z.array(z.object({
      slot: z.enum(BRAND_FONT_SLOTS),
      family: z.string(),
    })),
  }),
  sections: z.array(z.object({
    id: z.number(),
    name: z.string(),
    role: z.enum(SECTION_ROLES),
  })),
  elements: z.array(z.object({
    id: z.number(),
    role: z.string(),
  })),
  assets: z.array(z.object({
    file: z.string(),
    alias: z.string(),
  })),
});

// ---- Color canonicalizer (ported from project.ts — identical algorithm) ----
// Normalize any color literal to "r,g,b,a" string.

function canon(c: string): string {
  const s = c.trim().toLowerCase();
  let m: RegExpMatchArray | null, r: number, g: number, b: number, a = 1;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/))) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("") + "ff";
    else if (h.length === 4) h = h.split("").map((x) => x + x).join("");
    else if (h.length === 6) h = h + "ff";
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    a = parseInt(h.slice(6, 8), 16) / 255;
  } else if ((m = s.match(/^rgba?\(([^)]*)\)$/))) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    r = p[0]; g = p[1]; b = p[2]; a = p[3] === undefined ? 1 : p[3];
  } else {
    return s;
  }
  return `${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(4)}`;
}

const COLOR_RE = /rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g;

// ---- Tree helpers ----

function isEl(n: TreeNode): n is TreeEl { return (n as { t?: string }).t === undefined; }
function elKids(n: TreeEl): TreeEl[] { return n.children.filter(isEl) as TreeEl[]; }

function findTag(n: TreeEl, tag: string): TreeEl | null {
  if (n.tag === tag) return n;
  for (const c of elKids(n)) { const f = findTag(c, tag); if (f) return f; }
  return null;
}

/** Collect all text content from a subtree. */
function copyOf(n: TreeNode, acc: string[] = []): string[] {
  if (!isEl(n)) { if ((n as { t: string }).t.trim()) acc.push((n as { t: string }).t.trim()); return acc; }
  n.children.forEach((c) => copyOf(c, acc));
  return acc;
}

/** First heading (h1..h6) element in subtree, or null. */
function firstHeading(n: TreeEl): TreeEl | null {
  if (/^h[1-6]$/.test(n.tag)) return n;
  for (const c of elKids(n)) { const f = firstHeading(c); if (f) return f; }
  return null;
}

/** Collect all element ids in a subtree. */
function idsOf(n: TreeEl, acc: number[] = []): number[] {
  acc.push(n.id);
  n.children.filter(isEl).forEach((c) => idsOf(c as TreeEl, acc));
  return acc;
}

/** Build id → tag map for the entire tree. */
function buildTagMap(n: TreeEl, m: Record<number, string> = {}): Record<number, string> {
  m[n.id] = n.tag;
  n.children.filter(isEl).forEach((c) => buildTagMap(c as TreeEl, m));
  return m;
}

// ---- Section-role keyword matching ----
// Order matters: more specific first. Hero is special (first section fallback).
const ROLE_KEYWORDS: Array<[string, string[]]> = [
  ["testimonials",  ["testimonial", "review", "stories of glory", "story", "what our members", "what people say"]],
  ["coach-grid",    ["coach", "trainer", "team", "instructor", "staff"]],
  ["program-cards", ["program", "class", "workout", "training", "membership plan"]],
  ["pricing",       ["price", "pricing", "plan", "membership", "join", "cost", "fee", "subscription"]],
  ["faq",           ["faq", "frequently asked", "question", "q&a"]],
  ["contact-form",  ["contact", "reach us", "get in touch"]],
  ["lead-form",     ["sign up", "register", "enroll", "get started", "free trial", "start today"]],
  ["location-map",  ["location", "find us", "address", "map", "located", "directions"]],
  ["schedule",      ["schedule", "timetable", "class times", "calendar"]],
  ["stats-band",    ["members", "years", "classes", "sessions", "pounds", "athletes"]],
  ["cta-band",      ["get started", "try free", "book", "ready to", "join now", "start your", "take the first"]],
  ["logo-strip",    ["as seen in", "featured in", "partners", "sponsors"]],
  ["feature-grid",  ["features", "why us", "why choose", "benefits", "what we offer", "everything you need"]],
  ["media-block",   ["video", "watch", "reel"]],
];

function inferSectionRole(node: TreeEl, isFirst: boolean): typeof SECTION_ROLES[number] {
  const text = copyOf(node).join(" ").toLowerCase();
  for (const [role, keywords] of ROLE_KEYWORDS) {
    if (keywords.some((kw) => text.includes(kw))) return role as typeof SECTION_ROLES[number];
  }
  // first section with no match is likely a hero
  if (isFirst) return "hero";
  return "unknown";
}

/** Derive a PascalCase name from the section's first heading or first text, mirroring project.ts. */
function sectionName(node: TreeEl, index: number): string {
  const cp = copyOf(node);
  const h = cp.find((t) => t.trim().length > 5) ?? `Section ${index}`;
  let nm = h.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).slice(0, 3)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("").slice(0, 24)
    || `Section${index}`;
  if (/^[0-9]/.test(nm)) nm = "S" + nm;
  return nm + "Section";
}

// ---- Brand color analysis ----

interface ColorStats {
  canon: string;
  count: number;
  onInteractive: number;    // appears on a/button element styles
  asBackground: boolean;    // appears as background-color prop
  asText: boolean;          // appears as color prop
  r: number; g: number; b: number; a: number;
  saturation: number;       // max(r,g,b)-min(r,g,b) normalized 0..1
  lightness: number;        // (max+min)/2 normalized 0..1
  area: number;             // rough area-weight: count of background-color appearances
}

function parseCanon(c: string): { r: number; g: number; b: number; a: number } {
  const [r, g, b, a] = c.split(",").map(Number);
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a ?? 1 };
}

function computeSatLightness(r: number, g: number, b: number): { saturation: number; lightness: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const saturation = mx - mn; // chroma / saturation proxy
  const lightness = (mx + mn) / 2;
  return { saturation, lightness };
}

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea"]);
const TRANSPARENT_CANONS = new Set(["0,0,0,0", "255,255,255,0"]);

/** Walk the 1440 StyleMap, build per-color usage stats. */
function buildColorStats(
  S1: StyleMap,
  tagOf: Record<number, string>,
): Map<string, ColorStats> {
  const stats = new Map<string, ColorStats>();

  const get = (c: string, prop: string, id: number): ColorStats => {
    if (!stats.has(c)) {
      const { r, g, b, a } = parseCanon(c);
      const { saturation, lightness } = computeSatLightness(r, g, b);
      stats.set(c, { canon: c, count: 0, onInteractive: 0, asBackground: false, asText: false, r, g, b, a, saturation, lightness, area: 0 });
    }
    const st = stats.get(c)!;
    st.count++;
    if (INTERACTIVE_TAGS.has(tagOf[id] ?? "")) st.onInteractive++;
    if (prop === "background-color") { st.asBackground = true; st.area++; }
    if (prop === "color") st.asText = true;
    return st;
  };

  for (const idStr in S1) {
    const id = Number(idStr);
    const styles = S1[idStr];
    for (const [prop, val] of Object.entries(styles)) {
      for (const m of val.matchAll(COLOR_RE)) {
        const c = canon(m[0]);
        if (TRANSPARENT_CANONS.has(c)) continue; // skip transparent
        // Filter to color-bearing props only
        if (["color", "background-color", "border-color", "border-top-color",
          "border-bottom-color", "border-left-color", "border-right-color",
          "outline-color", "box-shadow", "fill", "stroke"].some((p) => prop.startsWith(p))) {
          get(c, prop, id);
        }
      }
    }
  }

  return stats;
}

/** Assign brand color slots from the usage stats. */
function assignColorSlots(stats: Map<string, ColorStats>): Array<{ slot: string; canon: string }> {
  // Filter: ignore very-transparent colors and near-white/near-black extremes for primary/accent
  const all = [...stats.values()].filter((s) => s.a > 0.05);
  if (all.length === 0) return [];

  const saturated = all.filter((s) => s.saturation > 0.12);
  const neutrals = all.filter((s) => s.saturation <= 0.12);

  const result: Array<{ slot: string; canon: string }> = [];
  const used = new Set<string>();

  // primary: most-used saturated color on interactive elements, else most-used saturated
  let primary: ColorStats | undefined;
  {
    const onInteractive = saturated.filter((s) => s.onInteractive > 0)
      .sort((a, b) => b.onInteractive - a.onInteractive || b.count - a.count);
    primary = onInteractive[0] ?? saturated.sort((a, b) => b.count - a.count)[0];
  }
  if (primary) { result.push({ slot: "primary", canon: primary.canon }); used.add(primary.canon); }

  // accent: next distinct saturated color (skip primary's canon)
  {
    const candidates = saturated.filter((s) => !used.has(s.canon))
      .sort((a, b) => b.count - a.count);
    const accent = candidates[0];
    if (accent) { result.push({ slot: "accent", canon: accent.canon }); used.add(accent.canon); }
  }

  // surface: dominant background color — prefer near-white high-lightness neutrals
  {
    const bgCandidates = all.filter((s) => s.asBackground && !used.has(s.canon))
      .sort((a, b) => b.area - a.area || b.lightness - a.lightness);
    // prefer light colors for surface (lightness > 0.7), fallback to most-area bg
    const lightBg = bgCandidates.find((s) => s.lightness > 0.7);
    const surface = lightBg ?? bgCandidates[0];
    if (surface) { result.push({ slot: "surface", canon: surface.canon }); used.add(surface.canon); }
  }

  // text: dominant text color — prefer dark
  {
    const textCandidates = all.filter((s) => s.asText && !used.has(s.canon))
      .sort((a, b) => b.count - a.count);
    const darkText = textCandidates.find((s) => s.lightness < 0.4);
    const text = darkText ?? textCandidates[0];
    if (text) { result.push({ slot: "text", canon: text.canon }); used.add(text.canon); }
  }

  // muted: mid-gray neutral (lightness 0.3-0.7) not yet assigned
  {
    const mutedCandidates = neutrals.filter((s) => !used.has(s.canon) && s.lightness >= 0.2 && s.lightness <= 0.75)
      .sort((a, b) => b.count - a.count);
    const muted = mutedCandidates[0];
    if (muted) { result.push({ slot: "muted", canon: muted.canon }); used.add(muted.canon); }
  }

  return result;
}

// ---- Brand font analysis ----

interface FontStats {
  family: string;
  count: number;
  maxSize: number;    // max font-size seen (px)
  maxWeight: number;  // max font-weight (numeric)
}

function parsePx(v: string): number {
  const m = v.match(/^([\d.]+)px$/);
  return m ? parseFloat(m[1]) : 0;
}

function parseWeight(v: string): number {
  if (v === "bold") return 700;
  if (v === "bolder") return 800;
  if (v === "lighter") return 300;
  const n = parseFloat(v);
  return isNaN(n) ? 400 : n;
}

function buildFontStats(S1: StyleMap): Map<string, FontStats> {
  const stats = new Map<string, FontStats>();
  for (const idStr in S1) {
    const styles = S1[idStr];
    const family = styles["font-family"];
    if (!family) continue;
    if (!stats.has(family)) stats.set(family, { family, count: 0, maxSize: 0, maxWeight: 0 });
    const st = stats.get(family)!;
    st.count++;
    const sz = parsePx(styles["font-size"] ?? "");
    if (sz > st.maxSize) st.maxSize = sz;
    const wt = parseWeight(styles["font-weight"] ?? "400");
    if (wt > st.maxWeight) st.maxWeight = wt;
  }
  return stats;
}

function assignFontSlots(stats: Map<string, FontStats>): Array<{ slot: string; family: string }> {
  if (stats.size === 0) return [];
  const all = [...stats.values()];

  // display: font with largest max-size (ties broken by max-weight then count)
  const byDisplay = [...all].sort((a, b) =>
    b.maxSize - a.maxSize || b.maxWeight - a.maxWeight || b.count - a.count,
  );
  const display = byDisplay[0];

  // body: most-used font overall (ties broken by count)
  const byCount = [...all].sort((a, b) => b.count - a.count);
  const body = byCount[0];

  const result: Array<{ slot: string; family: string }> = [];
  result.push({ slot: "display", family: display.family });
  // Only emit body if distinct from display
  if (body.family !== display.family) {
    result.push({ slot: "body", family: body.family });
  }
  return result;
}

// ---- Region partition (mirrors project.ts exactly) ----

function partitionRegions(tree: TreeEl): Array<{ index: number; node: TreeEl }> {
  const main = findTag(tree, "main") ?? tree;
  let sroot = main, sk = elKids(sroot);
  while (sk.length === 1) { sroot = sk[0]; sk = elKids(sroot); }
  return sk.map((node, index) => ({ index, node }));
}

// ---- Element labeling ----

function labelElements(tree: TreeEl, tagOf: Record<number, string>, primaryCanon: string | null, S1: StyleMap): Array<{ id: number; role: string }> {
  const elements: Array<{ id: number; role: string }> = [];

  // logo: first <img> inside a <header>
  const header = findTag(tree, "header");
  if (header) {
    const logoImg = findTag(header, "img");
    if (logoImg) elements.push({ id: logoImg.id, role: "logo" });
  }

  // headline: the <h1> in the tree
  const h1 = findTag(tree, "h1");
  if (h1) elements.push({ id: h1.id, role: "headline" });

  // primary-cta: find the most prominent <a> or <button>
  // Heuristic: interactive element whose background-color matches primary brand color,
  // else the interactive element with the largest font-size or most visual weight.
  let ctaId: number | null = null;
  if (primaryCanon) {
    // Walk all elements, find interactive ones with primary background
    const interactiveIds = Object.keys(S1)
      .map(Number)
      .filter((id) => INTERACTIVE_TAGS.has(tagOf[id] ?? ""));

    for (const id of interactiveIds) {
      const bg = S1[id]?.["background-color"];
      if (bg) {
        for (const m of bg.matchAll(COLOR_RE)) {
          if (canon(m[0]) === primaryCanon) { ctaId = id; break; }
        }
      }
      if (ctaId !== null) break;
    }

    // Fallback: largest interactive element by font-size
    if (ctaId === null && interactiveIds.length > 0) {
      const sorted = interactiveIds
        .filter((id) => S1[id]?.["font-size"])
        .sort((a, b) => parsePx(S1[b]?.["font-size"] ?? "") - parsePx(S1[a]?.["font-size"] ?? ""));
      ctaId = sorted[0] ?? null;
    }
  }
  if (ctaId !== null) elements.push({ id: ctaId, role: "primary-cta" });

  return elements;
}

// ---- Asset labeling ----

function labelAssets(tree: TreeEl): Array<{ file: string; alias: string }> {
  const assets: Array<{ file: string; alias: string }> = [];

  // logo: first img in header
  const header = findTag(tree, "header");
  if (header) {
    const logoImg = findTag(header, "img");
    if (logoImg?.attrs["src"]) {
      const src = logoImg.attrs["src"];
      const file = src.replace(/^.*?(assets\/[af]\d+\.\w+).*$/, "$1").split("?")[0];
      if (file.startsWith("assets/")) assets.push({ file, alias: "logo" });
    }
  }

  // hero image: first img in first section
  const regions = partitionRegions(tree);
  if (regions.length > 0) {
    const heroImg = findTag(regions[0].node, "img");
    if (heroImg?.attrs["src"]) {
      const src = heroImg.attrs["src"];
      const file = src.replace(/^.*?(assets\/[af]\d+\.\w+).*$/, "$1").split("?")[0];
      if (file.startsWith("assets/") && !assets.some((a) => a.file === file)) {
        assets.push({ file, alias: "hero-image" });
      }
    }
  }

  return assets;
}

// ---- Site metadata ----

function inferSiteName(head: CaptureJson["head"]): string {
  const title = head.title.trim();
  if (!title) return "Site";
  // strip common suffixes like " | Home", " - Official", etc.
  return title.replace(/\s*[|\-–—]\s*.+$/, "").trim() || title;
}

function inferSitePurpose(sections: Array<{ node: TreeEl }>): string {
  // Heuristic: look for keywords in all text to guess purpose
  const allText = sections.flatMap((s) => copyOf(s.node)).join(" ").toLowerCase();
  const gym = /\b(gym|fitness|crossfit|strength|workout|training|athletes?)\b/.test(allText);
  const boutique = /\b(boutique|studio|pilates|yoga|barre|spin)\b/.test(allText);
  if (boutique) return "boutique fitness studio landing page";
  if (gym) return "gym or fitness studio landing page";
  return "business landing page";
}

// ---- Main heuristic labeler ----

export function heuristicLabels(cap: CaptureJson): Labels {
  const S1 = cap.styles["1440"] ?? {};
  const tagOf = buildTagMap(cap.tree);

  // Regions (sections)
  const regions = partitionRegions(cap.tree);
  const seenNames = new Set<string>();
  const sections = regions.map(({ node }, idx) => {
    const role = inferSectionRole(node, idx === 0);
    let name = sectionName(node, idx);
    // deduplicate names
    if (seenNames.has(name)) {
      let i = 2;
      while (seenNames.has(name.replace(/Section$/, "") + `${i}Section`)) i++;
      name = name.replace(/Section$/, "") + `${i}Section`;
    }
    seenNames.add(name);
    return { id: node.id, name, role };
  });

  // Brand colors
  const colorStats = buildColorStats(S1, tagOf);
  const brandColors = assignColorSlots(colorStats);
  const primaryCanon = brandColors.find((c) => c.slot === "primary")?.canon ?? null;

  // Brand fonts
  const fontStats = buildFontStats(S1);
  const brandFonts = assignFontSlots(fontStats);

  // Elements
  const elements = labelElements(cap.tree, tagOf, primaryCanon, S1);

  // Assets
  const assets = labelAssets(cap.tree);

  // Site metadata
  const siteName = inferSiteName(cap.head);
  const sitePurpose = inferSitePurpose(regions);

  return {
    site: { name: siteName, purpose: sitePurpose },
    brand: { colors: brandColors, fonts: brandFonts },
    sections,
    elements,
    assets,
  };
}

// ---- Public entry-point ----

export async function label(opts: { dir: string; out?: string }): Promise<Labels> {
  const dir = path.resolve(opts.dir);
  const cap: CaptureJson = JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8"));
  const labels = heuristicLabels(cap);
  const outDir = path.resolve(opts.out ?? opts.dir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "labels.json"), JSON.stringify(labels, null, 2));
  return labels;
}
