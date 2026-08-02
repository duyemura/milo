/**
 * labels.ts — semantic labeling pass (Plan 2, Task 0)
 *
 * Reads capture.json → Labels. Two paths:
 *   - `heuristicLabels` (deterministic, no LLM) — the always-available baseline.
 *   - `llmLabels` (Task 6) — an ENHANCEMENT that assigns better semantic roles/slots.
 *     Never a hard dependency: `label()` falls back to the heuristic on any LLM failure
 *     or when disabled. Labels are metadata only — they never touch the byte-preserving
 *     render, so the pixel oracle is unaffected by which path ran.
 *
 * Key guarantee (heuristic): same capture.json → byte-identical labels.json every run
 * (no Date, no Math.random).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { chatCompletion, llmJson } from "@milo/llm";
import type { ChatFn, LlmConfig } from "@milo/llm";
import type {
  CaptureJson, TreeEl, TreeNode, StyleMap,
} from "./types.ts";
import {
  SECTION_ROLES, BRAND_COLOR_SLOTS, BRAND_FONT_SLOTS, ELEMENT_ROLES,
} from "./types.ts";
import type { Labels, ElementLabel } from "./types.ts";
import { canon, COLOR_RE, isEl, elKids, findTag, partitionRegions } from "./tree.ts";

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
    // Constrained to the known vocabulary — this is the one spot an LLM emits a free role
    // string, so an out-of-enum role is a repair signal (dropped by repairLabels).
    role: z.enum(ELEMENT_ROLES),
  })),
  assets: z.array(z.object({
    file: z.string(),
    alias: z.string(),
  })),
});

// ---- Tree helpers (canon/COLOR_RE/isEl/elKids/findTag/partitionRegions from tree.ts) ----

/** Collect all text content from a subtree. */
function copyOf(n: TreeNode, acc: string[] = []): string[] {
  if (!isEl(n)) { if ((n as { t: string }).t.trim()) acc.push((n as { t: string }).t.trim()); return acc; }
  n.children.forEach((c) => copyOf(c, acc));
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
  // An h1 is the page's primary heading — it lives in the hero by definition.
  // Check this BEFORE keyword matching so a hero with "Explore Our Locations" in
  // its CTA text isn't mislabeled location-map.
  if (findTag(node, "h1")) return "hero";
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

// ---- Element labeling ----

function labelElements(tree: TreeEl, tagOf: Record<number, string>, primaryCanon: string | null, S1: StyleMap): ElementLabel[] {
  const elements: ElementLabel[] = [];

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

// ============================================================================
// LLM labeling path (Plan 2, Task 6) — an ENHANCEMENT over the heuristic.
//
// The LLM ANNOTATES a faithful capture: it assigns better semantic roles/slots
// than keyword matching, but it NEVER generates content or layout. Its output is
// metadata only — the projected render stays byte-preserving regardless of which
// color is "primary" or which section is "hero". So the pixel oracle is untouched.
//
// It is never a hard dependency: any failure or a disabled flag falls back to
// `heuristicLabels`. Every id/color the LLM emits is post-validated against the
// real capture (hallucinated ids dropped, off-palette colors snapped/dropped) so
// the downstream byte-preserving mapping still holds.
// ============================================================================

// ---- Digest: a compact, token-budget-friendly view of the capture ----

interface DigestSection {
  id: number;
  tag: string;
  heading: string;       // first heading-ish text, trimmed
  snippet: string;       // short copy sample
  hasImages: boolean;
  hasForms: boolean;
  hasButtons: boolean;
}

interface DigestColor {
  canon: string;         // "r,g,b,a" — the exact key the LLM must echo back
  count: number;
  usedOn: string[];      // element types / prop context, e.g. ["background", "interactive", "text"]
}

interface DigestFont {
  family: string;
  count: number;
  maxSize: number;
  context: string;       // "display" | "body" heuristic hint
}

interface DigestAsset {
  file: string;
  alt: string;
  placement: string;     // e.g. "img in header", "img in section 0"
}

export interface Digest {
  site: { title: string };
  sections: DigestSection[];
  colors: DigestColor[];
  fonts: DigestFont[];
  assets: DigestAsset[];
  roleVocabulary: readonly string[];
  colorSlots: readonly string[];
  fontSlots: readonly string[];
}

/** Truncate to a max length on a word boundary (deterministic). */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

const FORM_TAGS = new Set(["form", "input", "textarea", "select"]);
const BUTTON_TAGS = new Set(["button"]);

/** Does the subtree contain any element matching `pred`? */
function subtreeHas(n: TreeEl, pred: (el: TreeEl) => boolean): boolean {
  if (pred(n)) return true;
  return elKids(n).some((c) => subtreeHas(c, pred));
}

function firstHeading(node: TreeEl): string {
  for (const tag of ["h1", "h2", "h3"]) {
    const h = findTag(node, tag);
    if (h) { const t = copyOf(h).join(" ").trim(); if (t) return t; }
  }
  return "";
}

/** Placement description for an <img> given its tree context. */
function imgPlacement(tree: TreeEl, img: TreeEl): string {
  const header = findTag(tree, "header");
  if (header && findTag(header, "img") === img) return "img in header";
  const regions = partitionRegions(tree);
  for (const { index, node } of regions) {
    if (findTag(node, "img") === img || subtreeHas(node, (el) => el === img)) {
      return `img in section ${index}`;
    }
  }
  return "img";
}

/** First rehosted asset file for an <img> src (assets/aN.ext), or null. */
function assetFile(src: string | undefined): string | null {
  if (!src) return null;
  const file = src.replace(/^.*?(assets\/[af]\d+\.\w+).*$/, "$1").split("?")[0];
  return file.startsWith("assets/") ? file : null;
}

/** Collect every <img> element in tree order. */
function collectImgs(n: TreeEl, acc: TreeEl[] = []): TreeEl[] {
  if (n.tag === "img") acc.push(n);
  for (const c of elKids(n)) collectImgs(c, acc);
  return acc;
}

/**
 * Build a COMPACT JSON view of the capture for the LLM to label. Keeps the token
 * budget small: top-level sections with a heading/snippet + content flags, the
 * color palette with usage stats, fonts with context, and assets with alt +
 * placement. No raw computed styles.
 */
export function buildDigest(cap: CaptureJson): Digest {
  const S1 = cap.styles["1440"] ?? {};
  const tagOf = buildTagMap(cap.tree);

  // Sections
  const regions = partitionRegions(cap.tree);
  const sections: DigestSection[] = regions.map(({ index, node }) => {
    const heading = firstHeading(node);
    const allCopy = copyOf(node).join(" ");
    return {
      id: node.id,
      tag: node.tag,
      heading: clip(heading, 80),
      snippet: clip(allCopy, 160),
      hasImages: subtreeHas(node, (el) => el.tag === "img"),
      hasForms: subtreeHas(node, (el) => FORM_TAGS.has(el.tag)),
      hasButtons: subtreeHas(node, (el) => BUTTON_TAGS.has(el.tag) ||
        (el.tag === "a" && /button|btn|cta/i.test(el.attrs["class"] ?? ""))),
    };
  });

  // Colors — reuse the same stats the heuristic uses, projected to a compact shape.
  const colorStats = buildColorStats(S1, tagOf);
  const colors: DigestColor[] = [...colorStats.values()]
    .filter((s) => s.a > 0.05)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12) // top palette entries by usage — plenty for slot assignment
    .map((s) => {
      const usedOn: string[] = [];
      if (s.asBackground) usedOn.push("background");
      if (s.asText) usedOn.push("text");
      if (s.onInteractive > 0) usedOn.push("interactive");
      return { canon: s.canon, count: s.count, usedOn };
    });

  // Fonts
  const fontStats = buildFontStats(S1);
  const fontsArr = [...fontStats.values()];
  const largest = [...fontsArr].sort((a, b) => b.maxSize - a.maxSize)[0];
  const fonts: DigestFont[] = fontsArr
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((f) => ({
      family: f.family,
      count: f.count,
      maxSize: f.maxSize,
      context: largest && f.family === largest.family ? "display-candidate" : "body-candidate",
    }));

  // Assets
  const assets: DigestAsset[] = [];
  const seenFiles = new Set<string>();
  for (const img of collectImgs(cap.tree)) {
    const file = assetFile(img.attrs["src"]);
    if (!file || seenFiles.has(file)) continue;
    seenFiles.add(file);
    assets.push({
      file,
      alt: clip(img.attrs["alt"] ?? "", 80),
      placement: imgPlacement(cap.tree, img),
    });
    if (assets.length >= 12) break;
  }

  return {
    site: { title: clip(cap.head.title, 120) },
    sections,
    colors,
    fonts,
    assets,
    roleVocabulary: SECTION_ROLES,
    colorSlots: BRAND_COLOR_SLOTS,
    fontSlots: BRAND_FONT_SLOTS,
  };
}

// ---- LLM labeler ----

const SYSTEM_PROMPT = [
  "You ANNOTATE a faithful website capture for a gym/fitness business. The site has already",
  "been captured pixel-for-pixel — your ONLY job is to assign better semantic labels than a",
  "keyword heuristic. You NEVER invent content, copy, colors, or layout: label only what is",
  "present in the digest.",
  "",
  "Assign each section a role from THIS exact vocabulary (use the section's `id` from the digest):",
  `  ${SECTION_ROLES.join(", ")}`,
  "Map brand colors to slots (echo the exact `canon` string from the digest palette — do not invent",
  `a color): ${BRAND_COLOR_SLOTS.join(", ")}. Map fonts to slots: ${BRAND_FONT_SLOTS.join(", ")}.`,
  "Identify element roles (e.g. logo, headline, primary-cta) and asset aliases (e.g. logo, hero-bg,",
  "hero-image) using the ids/files from the digest.",
  "",
  "Rules that MUST hold:",
  "- Every section `id` you return MUST be one of the section ids in the digest.",
  "- Every brand color `canon` you return MUST be one of the palette `canon` strings in the digest.",
  "- Every asset `file` you return MUST be one of the digest asset files.",
  "- Section roles MUST come from the vocabulary above; color/font slots from the slot lists.",
  "",
  "Return ONLY a JSON object matching this shape:",
  '{ "site": { "name": string, "purpose": string },',
  '  "brand": { "colors": [{ "slot": string, "canon": string }], "fonts": [{ "slot": string, "family": string }] },',
  '  "sections": [{ "id": number, "name": string, "role": string }],',
  '  "elements": [{ "id": number, "role": string }],',
  '  "assets": [{ "file": string, "alias": string }] }',
].join("\n");

/**
 * Post-validate an LLM Labels object against the real capture. The schema already
 * guarantees the SHAPE and the role/slot enums; this guards the *references*:
 * every section id, brand color canon, and asset file the LLM emitted must be REAL
 * (drawn from the capture). Hallucinated ids/files are dropped; off-palette colors
 * are snapped to the nearest captured canon, else dropped. This is what keeps the
 * downstream byte-preserving mapping intact even if the model gets creative.
 */
function repairLabels(llm: Labels, cap: CaptureJson): Labels {
  const digest = buildDigest(cap);
  const validSectionIds = new Set(digest.sections.map((s) => s.id));
  const validCanons = new Set(digest.colors.map((c) => c.canon));
  const validFiles = new Set(digest.assets.map((a) => a.file));
  const tagOf = buildTagMap(cap.tree);
  const validElementIds = new Set(Object.keys(tagOf).map(Number));

  // Sections: drop hallucinated ids; keep at most one label per real id (first wins).
  const seenSec = new Set<number>();
  const sections = llm.sections.filter((s) => {
    if (!validSectionIds.has(s.id) || seenSec.has(s.id)) return false;
    seenSec.add(s.id);
    return true;
  });

  // Elements: drop ids that aren't real captured elements, and any role outside the known
  // ELEMENT_ROLES vocabulary (the schema already enforces the enum on the LLM path; this keeps
  // the invariant if repairLabels is ever handed labels from another source).
  const validRoles = new Set<string>(ELEMENT_ROLES);
  const elements = llm.elements.filter((e) => validElementIds.has(e.id) && validRoles.has(e.role));

  // Assets: drop files not in the capture; de-dupe by file.
  const seenFile = new Set<string>();
  const assets = llm.assets.filter((a) => {
    if (!validFiles.has(a.file) || seenFile.has(a.file)) return false;
    seenFile.add(a.file);
    return true;
  });

  // Brand colors: canon must be a real captured palette color. If not, snap to the
  // nearest captured canon by Euclidean RGB distance; drop if no palette exists.
  const paletteCanons = [...validCanons];
  const usedSlots = new Set<string>();
  const colors = llm.brand.colors.flatMap((c) => {
    if (usedSlots.has(c.slot)) return [];
    let canonVal = c.canon;
    if (!validCanons.has(canonVal)) {
      const snapped = snapToNearestCanon(canonVal, paletteCanons);
      if (!snapped) return [];
      canonVal = snapped;
    }
    usedSlots.add(c.slot);
    return [{ slot: c.slot, canon: canonVal }];
  });

  // Fonts: the schema constrains the slot enum, but NOT that `family` is a real captured
  // font. A hallucinated family would leak into brand.json (metadata-only, but keep labels
  // honest). Validate each family against the captured font-families; if it doesn't match,
  // snap to the heuristic's font for that slot (which is drawn from the capture), else drop.
  const S1 = cap.styles["1440"] ?? {};
  const capturedFamilies = new Set(buildFontStats(S1).keys());
  const heuristicFontOfSlot = new Map(assignFontSlots(buildFontStats(S1)).map((f) => [f.slot, f.family] as const));
  const usedFontSlots = new Set<string>();
  const fonts = llm.brand.fonts.flatMap((f) => {
    if (usedFontSlots.has(f.slot)) return [];
    let family = f.family;
    if (!capturedFamilies.has(family)) {
      const fallback = heuristicFontOfSlot.get(f.slot);
      if (!fallback) return []; // no captured font for this slot — drop rather than hallucinate
      family = fallback;
    }
    usedFontSlots.add(f.slot);
    return [{ slot: f.slot, family }];
  });

  return {
    site: llm.site,
    brand: { colors, fonts },
    sections,
    elements,
    assets,
  };
}

/** Snap an arbitrary color string to the nearest captured canon, or null if none. */
function snapToNearestCanon(c: string, palette: string[]): string | null {
  if (palette.length === 0) return null;
  const target = parseCanon(canon(c));
  let best: string | null = null;
  let bestDist = Infinity;
  for (const p of palette) {
    const pc = parseCanon(p);
    const d = (target.r - pc.r) ** 2 + (target.g - pc.g) ** 2 + (target.b - pc.b) ** 2;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

/**
 * Label a capture with the LLM. Builds a system prompt + a compact digest, calls
 * `llmJson` (JSON-mode + Zod validation + self-correcting retries against
 * `LabelSchema`), then post-validates every emitted id/color/file against the real
 * capture. Throws on failure — the caller (`label`) is responsible for falling back
 * to the heuristic.
 */
export async function llmLabels(cap: CaptureJson, chat: ChatFn, model: string): Promise<Labels> {
  const digest = buildDigest(cap);
  const raw = await llmJson(LabelSchema, {
    chat,
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Digest of the captured site:\n${JSON.stringify(digest)}` },
    ],
    temperature: 0.1,
  });
  return repairLabels(raw, cap);
}

/** Build an `LlmConfig` from process.env, or null if no provider is configured. */
function configFromEnv(): { config: LlmConfig; model: string } | null {
  const provider = process.env.LLM_PROVIDER;
  if (provider !== "openrouter" && provider !== "ollama") return null;
  const model = process.env.DEFAULT_LLM_MODEL;
  if (!model) {
    console.warn(`[labels] LLM_PROVIDER=${provider} is set but DEFAULT_LLM_MODEL is missing; falling back to heuristic labeling`);
    return null;
  }
  if (provider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
    console.warn(`[labels] LLM_PROVIDER=openrouter is set but OPENROUTER_API_KEY is missing; falling back to heuristic labeling`);
    return null;
  }
  const config: LlmConfig = {
    provider,
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaApiKey: process.env.OLLAMA_API_KEY,
  };
  return { config, model };
}

// ---- Public entry-point ----

/**
 * Discriminated result from label(): reports which code path ran and why,
 * so callers can distinguish a genuine LLM run from a silent error fallback.
 */
export type LabelSource =
  | "llm-fresh"           // LLM ran and succeeded (cost incurred)
  | "heuristic-disabled"  // llm:false was passed — intentional no-LLM run
  | "heuristic-error";    // LLM was attempted but threw; fell back to heuristic

export interface LabelResult {
  labels: Labels;
  source: LabelSource;
  /** Set when source="heuristic-error": the error message from the LLM call. */
  fallbackReason?: string;
}

/**
 * Read `capture.json`, produce `Labels`, write `labels.json`.
 *
 * LLM is an ENHANCEMENT, never a dependency: if `llm !== false` and `LLM_PROVIDER`
 * is configured (with API key present), we try `llmLabels`; on ANY error we log a
 * warning and fall back to the deterministic `heuristicLabels`. With `llm: false`
 * or no provider/key, we go straight to the heuristic. Either path yields a valid,
 * schema-conformant site.
 *
 * Returns a `LabelResult` with `source` and optional `fallbackReason` so callers
 * can distinguish an honest LLM success from a silent error fallback.
 */
export async function label(opts: { dir: string; out?: string; llm?: boolean }): Promise<LabelResult> {
  const dir = path.resolve(opts.dir);
  const cap: CaptureJson = JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8"));

  let labels: Labels;
  let source: LabelSource;
  let fallbackReason: string | undefined;

  const env = opts.llm !== false ? configFromEnv() : null;
  if (env) {
    try {
      const chat: ChatFn = (o) => chatCompletion(o, env.config);
      labels = await llmLabels(cap, chat, env.model);
      source = "llm-fresh";
      console.log(`[labels] LLM path (${env.model}) — annotated ${labels.sections.length} sections`);
    } catch (err) {
      fallbackReason = (err as Error).message;
      console.warn(`[labels] LLM labeling failed (${fallbackReason}); falling back to heuristic`);
      labels = heuristicLabels(cap);
      source = "heuristic-error";
    }
  } else {
    labels = heuristicLabels(cap);
    source = "heuristic-disabled";
    console.log("[labels] heuristic path" + (opts.llm === false ? " (llm disabled)" : " (no LLM_PROVIDER)"));
  }

  const outDir = path.resolve(opts.out ?? opts.dir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "labels.json"), JSON.stringify(labels, null, 2));
  return { labels, source, fallbackReason };
}
