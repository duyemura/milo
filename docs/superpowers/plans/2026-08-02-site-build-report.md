# Site Build Report — Ship/No-Ship Gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-build `inspectSite(opts) → SiteReport` pipeline that runs a battery of quality checks on any built site (clone, template, or bespoke) and produces a ship/no-ship verdict plus a punch-list HTML report.

**Architecture:** A new `src/buildreport/` module in `@milo/clone-engine`. Each check is an independent function in `src/buildreport/checks/` — its own file, its own unit tests, its own fixtures. An orchestrator (`inspector.ts`) runs them all and merges issues into a `SiteReport`. A renderer (`render.ts`) produces `site-report.html` + `site-report.json`. `buildSiteAuto` in `orchestrate.ts` calls the inspector after assembly and writes the report to `full-site/`. Clone-fidelity checks (pixel diff, iframe preservation, SEO regression) only run when `opts.source.captureDir` is provided — the report format is identical either way.

**Tech Stack:** Node 24 TypeScript, `@milo/clone-engine`, Playwright (render-based checks), `src/pixel.ts` (pixelDiff), `src/edit/snapshot.ts` (renderSnapshot/sectionListOf), `src/edit/verify.ts` (overlaps — export needed), Vitest.

---

## File structure

```
packages/clone-engine/src/buildreport/
  types.ts                  # Issue, SiteReport, PageContext, InspectOpts — shared vocabulary
  html.ts                   # Dependency-free HTML parser helpers (getAttribute, queryAll, textContent)
  checks/
    broken-assets.ts        # 0×0 images + missing asset files in dist
    content-blocks.ts       # site.json sections present + non-empty in built HTML
    dead-links.ts           # internal hrefs resolve to built routes
    seo.ts                  # title/desc/h1/canonical/OG/alt; source regression when source provided
    pagespeed.ts            # page weight KB + asset count (informational)
    iframes.ts              # source iframes preserved in clone (clone-only)
    fidelity.ts             # pixel diff vs source-desktop.png (clone-only)
    layout-breaks.ts        # section bounding-box overlaps — uses renderSnapshot + overlaps()
    font-fallback.ts        # brand fonts referenced in global.css + dist HTML
  inspector.ts              # run all checks → SiteReport with verdict
  render.ts                 # SiteReport → HTML string + JSON
  index.ts                  # barrel

packages/clone-engine/test/buildreport/
  fixtures.ts               # minimal hand-written site-dir + capture-dir builders
  broken-assets.test.ts
  content-blocks.test.ts
  dead-links.test.ts
  seo.test.ts
  pagespeed.test.ts
  iframes.test.ts
  fidelity.test.ts
  layout-breaks.test.ts     # integration (skipIf !ASTRO_MODULES)
  font-fallback.test.ts
  inspector.test.ts
  render.test.ts
```

**Existing files to modify:**
- `src/edit/verify.ts` — export `overlaps` and `OVERLAP_TOLERANCE_PX` (T0)
- `src/orchestrate.ts` — call inspector after assembly, write report (T12)
- `src/index.ts` — export `inspectSite`, `SiteReport` (T12)

---

## Task 0: Types + HTML helpers + test fixtures

**Files:**
- Create: `packages/clone-engine/src/buildreport/types.ts`
- Create: `packages/clone-engine/src/buildreport/html.ts`
- Create: `packages/clone-engine/src/buildreport/index.ts`
- Create: `packages/clone-engine/test/buildreport/fixtures.ts`
- Modify: `packages/clone-engine/src/edit/verify.ts` (export overlaps + tolerance)

- [ ] **Step 1 — write types.ts**

```ts
import type { Browser } from "playwright";

export type IssueSeverity = "blocker" | "note" | "info";

export interface Issue {
  severity: IssueSeverity;
  page: string;         // route e.g. "/" or "/about/"
  section?: string;     // data-component name if section-scoped
  kind: string;         // machine-readable check id e.g. "broken-asset"
  detail: string;       // human-readable one-liner
}

export interface CheckResult { issues: Issue[]; }

/** Context passed to every check for a single page. */
export interface PageContext {
  route: string;
  /** Absolute path to the built dist/index.html (or dist/<route>/index.html). */
  distHtmlPath: string;
  /** Parsed text of the built HTML file. */
  distHtml: string;
  /** Absolute path to the built dist/ directory for this page. */
  distDir: string;
  /** Absolute path to the site dir (has site.json, astro/). */
  siteDir: string;
}

export interface InspectOpts {
  /** Projected site dir (has site.json + astro/dist/). */
  siteDir: string;
  /** Playwright browser for render-based checks (layout-breaks, font-fallback, fidelity). */
  browser: Browser;
  /** Default render width. @default 1440 */
  width?: number;
  /** Supply for clone-fidelity checks (SEO regression, iframe preservation, pixel diff). */
  source?: { captureDir: string };
}

export interface PageReport {
  route: string;
  issues: Issue[];
  fidelityPct?: number;    // 0-100, only when source provided
  pageWeightKb: number;
}

export interface SiteReport {
  /** "SHIP" = zero blockers. "NEEDS_FIXES" = ≥1 blocker. */
  verdict: "SHIP" | "NEEDS_FIXES";
  blockerCount: number;
  noteCount: number;
  infoCount: number;
  issues: Issue[];
  pages: PageReport[];
  generatedAt: string;   // ISO timestamp
}
```

- [ ] **Step 2 — write html.ts** (no deps — plain regex/string ops on an HTML string)

```ts
/** Extract the value of an attribute from the first matching tag. Returns undefined if absent. */
export function getAttribute(html: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, "i");
  return html.match(re)?.[1];
}

/** Extract all values of one attribute from every matching tag. */
export function getAllAttributes(html: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, "gi");
  return [...html.matchAll(re)].map((m) => m[1]);
}

/** Extract the text content of the first matching tag. */
export function getTextContent(html: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = html.match(re);
  return m ? m[1].trim() : undefined;
}

/** Count how many times a tag appears. */
export function countTag(html: string, tag: string): number {
  return [...html.matchAll(new RegExp(`<${tag}[\\s>]`, "gi"))].length;
}

/** Extract all `<meta name="..." content="...">` as a map. */
export function parseMetas(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/name=["']([^"']*)["']/i)?.[1]?.toLowerCase();
    const prop = tag.match(/property=["']([^"']*)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) out.set(name, content);
    if (prop) out.set(prop, content);
  }
  return out;
}

/** Check if JSON-LD structured data is present. */
export function hasJsonLd(html: string): boolean {
  return /<script[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(html);
}

/** Extract all href values from <a> tags. */
export function getLinks(html: string): string[] {
  return getAllAttributes(html, "a", "href");
}

/** Extract all src values from <img> tags. */
export function getImgSrcs(html: string): string[] {
  return getAllAttributes(html, "img", "src");
}

/** Extract background-image url() values from inline style attributes + <style> blocks. */
export function getCssBackgroundUrls(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/gi)) {
    out.push(m[1].trim());
  }
  return out;
}

/** Extract all <iframe src> values. */
export function getIframeSrcs(html: string): string[] {
  return getAllAttributes(html, "iframe", "src");
}

/** Count images missing alt attributes. */
export function countImgsWithoutAlt(html: string): number {
  const imgs = [...html.matchAll(/<img\s[^>]*>/gi)].map((m) => m[0]);
  return imgs.filter((tag) => !/\balt\s*=/i.test(tag)).length;
}
```

- [ ] **Step 3 — export overlaps from verify.ts**

Open `packages/clone-engine/src/edit/verify.ts`, find `OVERLAP_TOLERANCE_PX` and `overlaps`, change them from:
```ts
const OVERLAP_TOLERANCE_PX = 2;
function overlaps(a: ...): boolean {
```
to:
```ts
export const OVERLAP_TOLERANCE_PX = 2;
export function overlaps(a: ...): boolean {
```

- [ ] **Step 4 — write test/buildreport/fixtures.ts**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Build a minimal site dir in a temp dir. Returns its path. */
export function makeSiteDir(opts: {
  distHtml?: string;
  siteJsonSections?: { name: string; role: string; copyKeys: string[] }[];
  brandFonts?: { slot: string; family: string }[];
} = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-site-"));
  const distDir = path.join(dir, "astro", "dist");
  const stylesDir = path.join(dir, "astro", "src", "styles");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(stylesDir, { recursive: true });

  const sections = opts.siteJsonSections ?? [
    { name: "HeroSection", role: "hero", copyKeys: ["HeroSection.0", "HeroSection.1"] },
  ];
  const siteJson = {
    brand: "astro/brand.json",
    pages: [{
      route: "/", component: "Index", type: "home", goal: "convert",
      sections,
      elements: [], assets: [], copy: sections.flatMap((s, i) =>
        s.copyKeys.map((k, j) => ({ key: k, component: s.name, index: j, text: `Copy ${i}.${j}` }))
      ),
    }],
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(siteJson, null, 2));

  const fonts = opts.brandFonts ?? [{ slot: "display", family: "TestFont" }];
  const brandJson = {
    colors: [{ slot: "primary", value: "#ff0000" }],
    fonts: fonts.map((f) => ({ slot: f.slot, family: f.family })),
  };
  fs.writeFileSync(path.join(dir, "astro", "brand.json"), JSON.stringify(brandJson));
  fs.writeFileSync(
    path.join(stylesDir, "global.css"),
    fonts.map((f) => `@font-face { font-family: '${f.family}'; src: url('/${f.family}.woff2'); }`).join("\n"),
  );

  const html = opts.distHtml ?? sections.map((s) =>
    `<section data-component="${s.name}" data-section="${s.role}">${s.copyKeys.map((k) => `<p data-copy="${k}">Content for ${k}</p>`).join("")}</section>`
  ).join("\n");

  fs.writeFileSync(
    path.join(distDir, "index.html"),
    `<!doctype html><html lang="en"><head><title>Test Site</title><meta name="description" content="A test site"></head><body>${html}</body></html>`,
  );
  return dir;
}

/** A 1×1 transparent PNG buffer (for fidelity/pixel tests). */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Build a minimal clone source capture dir. */
export function makeCaptureDir(opts: { title?: string; description?: string; iframeSrcs?: string[] } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-capture-"));
  const captureJson = {
    tree: { id: 0, tag: "body", attrs: {}, children: [
      ...(opts.iframeSrcs ?? []).map((src, i) => ({ id: i + 1, tag: "iframe", attrs: { src }, children: [] })),
    ]},
    styles: {},
    head: {
      title: opts.title ?? "Source Title",
      lang: "en",
      metas: [{ key: "description", content: opts.description ?? "Source description" }],
      icons: [], sheetHrefs: [], fontFaces: "",
    },
    fontCss: "",
    interactions: null,
    sourceOrigins: [],
  };
  fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify(captureJson));
  fs.writeFileSync(path.join(dir, "source-desktop.png"), TINY_PNG);
  return dir;
}
```

- [ ] **Step 5 — write barrel index.ts**

```ts
export * from "./types.ts";
export { inspectSite } from "./inspector.ts";
export type { SiteReport } from "./types.ts";
```

- [ ] **Step 6 — typecheck + commit**
  - Run: `cd packages/clone-engine && node_modules/.bin/tsc --noEmit` → Expected: clean
  - Commit:
```bash
git add packages/clone-engine/src/buildreport/types.ts \
        packages/clone-engine/src/buildreport/html.ts \
        packages/clone-engine/src/buildreport/index.ts \
        packages/clone-engine/test/buildreport/fixtures.ts \
        packages/clone-engine/src/edit/verify.ts
git commit -m "feat(qa): scaffold types + html helpers + fixtures; export overlaps (QA-T0)"
```

---

## Task 1: broken-assets check

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/broken-assets.ts`
- Create: `packages/clone-engine/test/buildreport/broken-assets.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkBrokenAssets } from "../../src/buildreport/checks/broken-assets.ts";
import { makeSiteDir } from "./fixtures.ts";

describe("checkBrokenAssets", () => {
  it("returns no issues when all images exist on disk", async () => {
    const siteDir = makeSiteDir({ distHtml: '<img src="/assets/logo.png"><p>ok</p>' });
    // Create the asset file
    fs.mkdirSync(path.join(siteDir, "astro/dist/assets"), { recursive: true });
    fs.writeFileSync(path.join(siteDir, "astro/dist/assets/logo.png"), "fake-png");
    const result = await checkBrokenAssets({ route: "/", distHtmlPath: path.join(siteDir, "astro/dist/index.html"), distHtml: fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8"), distDir: path.join(siteDir, "astro/dist"), siteDir });
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when an image src resolves to a missing file", async () => {
    const siteDir = makeSiteDir({ distHtml: '<img src="/assets/missing.png"><p>ok</p>' });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkBrokenAssets({ route: "/", distHtmlPath: path.join(siteDir, "astro/dist/index.html"), distHtml: html, distDir: path.join(siteDir, "astro/dist"), siteDir });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("blocker");
    expect(result.issues[0].kind).toBe("broken-asset");
    expect(result.issues[0].detail).toContain("missing.png");
  });

  it("blocks when a CSS background-image url() references a missing file", async () => {
    const siteDir = makeSiteDir({ distHtml: '<style>body{background-image:url("/bg.jpg")}</style>' });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkBrokenAssets({ route: "/", distHtmlPath: path.join(siteDir, "astro/dist/index.html"), distHtml: html, distDir: path.join(siteDir, "astro/dist"), siteDir });
    expect(result.issues.some((i) => i.kind === "broken-asset" && i.detail.includes("bg.jpg"))).toBe(true);
  });

  it("skips external URLs", async () => {
    const siteDir = makeSiteDir({ distHtml: '<img src="https://external.com/img.png">' });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkBrokenAssets({ route: "/", distHtmlPath: path.join(siteDir, "astro/dist/index.html"), distHtml: html, distDir: path.join(siteDir, "astro/dist"), siteDir });
    expect(result.issues).toHaveLength(0);
  });
});
```

- [ ] **Step 2 — run to verify it fails** → Expected: FAIL (module not found)

- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import { getImgSrcs, getCssBackgroundUrls } from "../html.ts";

function resolveAsset(src: string, distDir: string): string | null {
  if (/^https?:\/\//.test(src) || src.startsWith("data:") || src.startsWith("//")) return null;
  const rel = src.startsWith("/") ? src.slice(1) : src;
  return path.join(distDir, rel);
}

export async function checkBrokenAssets(page: PageContext): Promise<CheckResult> {
  const issues = [];
  const candidates = [
    ...getImgSrcs(page.distHtml),
    ...getCssBackgroundUrls(page.distHtml),
  ];
  for (const src of candidates) {
    const abs = resolveAsset(src, page.distDir);
    if (!abs) continue;
    if (!fs.existsSync(abs)) {
      issues.push({ severity: "blocker" as const, page: page.route, kind: "broken-asset", detail: `Asset not found: ${src}` });
    }
  }
  return { issues };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 4 passed
- [ ] **Step 5 — typecheck + commit**
```bash
git add packages/clone-engine/src/buildreport/checks/broken-assets.ts \
        packages/clone-engine/test/buildreport/broken-assets.test.ts
git commit -m "feat(qa): broken-assets check (QA-T1)"
```

---

## Task 2: content-blocks check

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/content-blocks.ts`
- Create: `packages/clone-engine/test/buildreport/content-blocks.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkContentBlocks } from "../../src/buildreport/checks/content-blocks.ts";
import { makeSiteDir } from "./fixtures.ts";

describe("checkContentBlocks", () => {
  it("no issues when all sections present and have content", async () => {
    const siteDir = makeSiteDir();
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkContentBlocks({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when a section from site.json is absent in built HTML", async () => {
    const siteDir = makeSiteDir({ distHtml: "<p>no sections here</p>" });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkContentBlocks({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "missing-section")).toBe(true);
  });

  it("blocks when a section exists but has no text content", async () => {
    const siteDir = makeSiteDir({
      siteJsonSections: [{ name: "HeroSection", role: "hero", copyKeys: ["HeroSection.0"] }],
      distHtml: '<section data-component="HeroSection" data-section="hero">   </section>',
    });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkContentBlocks({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "empty-section")).toBe(true);
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { SiteManifest } from "../../types.ts";

export async function checkContentBlocks(page: PageContext): Promise<CheckResult> {
  const manifest = JSON.parse(fs.readFileSync(path.join(page.siteDir, "site.json"), "utf8")) as SiteManifest;
  const pageSections = manifest.pages[0]?.sections ?? [];
  const issues = [];

  for (const section of pageSections) {
    const marker = `data-component="${section.name}"`;
    if (!page.distHtml.includes(marker)) {
      issues.push({ severity: "blocker" as const, page: page.route, section: section.name, kind: "missing-section", detail: `Section "${section.name}" from site.json is absent in the built HTML` });
      continue;
    }
    // Extract the section's text content (strip HTML tags between the data-component open and close)
    const start = page.distHtml.indexOf(`data-component="${section.name}"`);
    const tagStart = page.distHtml.lastIndexOf("<", start);
    const end = page.distHtml.indexOf("</section>", tagStart);
    if (end === -1) continue;
    const inner = page.distHtml.slice(tagStart, end + 10).replace(/<[^>]+>/g, " ");
    if (inner.trim().length === 0) {
      issues.push({ severity: "blocker" as const, page: page.route, section: section.name, kind: "empty-section", detail: `Section "${section.name}" exists but has no visible text content` });
    }
  }
  return { issues };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 3 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/content-blocks.ts \
        packages/clone-engine/test/buildreport/content-blocks.test.ts
git commit -m "feat(qa): content-blocks check (QA-T2)"
```

---

## Task 3: dead-links check

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/dead-links.ts`
- Create: `packages/clone-engine/test/buildreport/dead-links.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import { checkDeadLinks } from "../../src/buildreport/checks/dead-links.ts";
import { makeSiteDir } from "./fixtures.ts";
import fs from "node:fs"; import path from "node:path";

const ctx = (siteDir: string, html: string) => ({
  route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir,
});

describe("checkDeadLinks", () => {
  it("no issues when all internal links resolve to built routes", async () => {
    const siteDir = makeSiteDir({ distHtml: '<a href="/">Home</a>' });
    const result = await checkDeadLinks(ctx(siteDir, fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8")));
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when an internal link has no matching built page", async () => {
    const siteDir = makeSiteDir({ distHtml: '<a href="/missing-page/">Go there</a>' });
    const result = await checkDeadLinks(ctx(siteDir, fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8")));
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "dead-link")).toBe(true);
  });

  it("skips external, mailto, tel, and hash-only links", async () => {
    const siteDir = makeSiteDir({ distHtml: '<a href="https://example.com">ext</a><a href="mailto:a@b.com">mail</a><a href="#section">hash</a><a href="tel:+1234">tel</a>' });
    const result = await checkDeadLinks(ctx(siteDir, fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8")));
    expect(result.issues).toHaveLength(0);
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { SiteManifest } from "../../types.ts";
import { getLinks } from "../html.ts";

function isInternal(href: string): boolean {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  return !href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("//");
}

function normalizeRoute(href: string): string {
  const p = href.split("?")[0].split("#")[0];
  return p.endsWith("/") ? p : p + "/";
}

export async function checkDeadLinks(page: PageContext): Promise<CheckResult> {
  const manifest = JSON.parse(fs.readFileSync(path.join(page.siteDir, "site.json"), "utf8")) as SiteManifest;
  const builtRoutes = new Set(manifest.pages.map((p) => p.route));
  // Also include root "/" for relative hrefs like "/"
  builtRoutes.add("/");

  const issues = [];
  for (const href of getLinks(page.distHtml)) {
    if (!isInternal(href)) continue;
    const route = normalizeRoute(href);
    if (!builtRoutes.has(route)) {
      issues.push({ severity: "blocker" as const, page: page.route, kind: "dead-link", detail: `Internal link "${href}" has no matching built page` });
    }
  }
  return { issues };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 3 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/dead-links.ts \
        packages/clone-engine/test/buildreport/dead-links.test.ts
git commit -m "feat(qa): dead-links check (QA-T3)"
```

---

## Task 4: SEO check

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/seo.ts`
- Create: `packages/clone-engine/test/buildreport/seo.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import { checkSeo } from "../../src/buildreport/checks/seo.ts";
import { makeSiteDir, makeCaptureDir } from "./fixtures.ts";
import fs from "node:fs"; import path from "node:path";

const ctx = (siteDir: string, html: string, sourceCapture?: string) => ({
  route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir,
  ...(sourceCapture ? { source: { captureDir: sourceCapture } } : {}),
});

describe("checkSeo", () => {
  it("no issues on a well-formed page", async () => {
    const siteDir = makeSiteDir({ distHtml: '<h1>Heading</h1><img alt="logo" src="/logo.png">' });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkSeo({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    // title + meta description are in the fixture HTML
    expect(result.issues.filter((i) => i.severity === "blocker")).toHaveLength(0);
  });

  it("info when h1 is missing", async () => {
    const siteDir = makeSiteDir({ distHtml: '<p>no heading</p>' });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkSeo({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    expect(result.issues.some((i) => i.kind === "seo-missing-h1")).toBe(true);
  });

  it("blocker when source had a title but clone does not", async () => {
    const captureDir = makeCaptureDir({ title: "Source Title" });
    const siteDir = makeSiteDir({ distHtml: "<p>no title tag</p>" });
    // Overwrite the fixture to remove title
    const distPath = path.join(siteDir, "astro/dist/index.html");
    fs.writeFileSync(distPath, '<!doctype html><html><head></head><body><p>no title</p></body></html>');
    const result = await checkSeo({ route: "/", distHtmlPath: distPath, distHtml: fs.readFileSync(distPath, "utf8"), distDir: path.join(siteDir, "astro/dist"), siteDir, source: { captureDir } } as any);
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "seo-regression")).toBe(true);
  });

  it("info (not blocker) when source also lacked a meta description", async () => {
    const captureDir = makeCaptureDir({ description: "" }); // source had no description
    const siteDir = makeSiteDir({ distHtml: "<p>no meta desc</p>" });
    const distPath = path.join(siteDir, "astro/dist/index.html");
    fs.writeFileSync(distPath, '<!doctype html><html><head><title>T</title></head><body></body></html>');
    const result = await checkSeo({ route: "/", distHtmlPath: distPath, distHtml: fs.readFileSync(distPath, "utf8"), distDir: path.join(siteDir, "astro/dist"), siteDir, source: { captureDir } } as any);
    // Source also lacked it → not a regression → no blocker
    expect(result.issues.filter((i) => i.severity === "blocker" && i.kind === "seo-regression")).toHaveLength(0);
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { CheckResult, Issue, PageContext, InspectOpts } from "../types.ts";
import type { CaptureJson } from "../../types.ts";
import { getTextContent, countTag, parseMetas, hasJsonLd, countImgsWithoutAlt } from "../html.ts";

type SeoCtx = PageContext & Pick<InspectOpts, "source">;

function parseSourceSeo(captureDir: string): { title: string; description: string } {
  const cap = JSON.parse(fs.readFileSync(path.join(captureDir, "capture.json"), "utf8")) as CaptureJson;
  const title = cap.head.title ?? "";
  const description = cap.head.metas.find((m) => m.key === "description")?.content ?? "";
  return { title, description };
}

export async function checkSeo(ctx: SeoCtx): Promise<CheckResult> {
  const issues: Issue[] = [];
  const html = ctx.distHtml;

  const title = getTextContent(html, "title");
  const metas = parseMetas(html);
  const h1Count = countTag(html, "h1");
  const missingAlt = countImgsWithoutAlt(html);
  const hasLd = hasJsonLd(html);

  if (!title) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-title", detail: "Page has no <title> tag" });
  if (!metas.get("description")) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-description", detail: "Page has no meta description" });
  if (h1Count === 0) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-h1", detail: "Page has no <h1> heading" });
  if (h1Count > 1) issues.push({ severity: "info", page: ctx.route, kind: "seo-multiple-h1", detail: `Page has ${h1Count} <h1> headings (should be exactly 1)` });
  if (missingAlt > 0) issues.push({ severity: "info", page: ctx.route, kind: "seo-missing-alt", detail: `${missingAlt} image(s) lack alt attributes` });
  if (!hasLd) issues.push({ severity: "info", page: ctx.route, kind: "seo-no-json-ld", detail: "No JSON-LD structured data found" });

  // Clone regression check: source had a field → clone must keep it.
  if (ctx.source?.captureDir) {
    const src = parseSourceSeo(ctx.source.captureDir);
    if (src.title && !title) {
      issues.push({ severity: "blocker", page: ctx.route, kind: "seo-regression", detail: `<title> was "${src.title}" in source but is missing in clone` });
    }
    if (src.description && !metas.get("description")) {
      issues.push({ severity: "blocker", page: ctx.route, kind: "seo-regression", detail: `meta description was present in source but is missing in clone` });
    }
  }

  return { issues };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 4 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/seo.ts \
        packages/clone-engine/test/buildreport/seo.test.ts
git commit -m "feat(qa): SEO check with source-regression detection (QA-T4)"
```

---

## Task 5: pagespeed check

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/pagespeed.ts`
- Create: `packages/clone-engine/test/buildreport/pagespeed.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { checkPagespeed } from "../../src/buildreport/checks/pagespeed.ts";
import { makeSiteDir } from "./fixtures.ts";

describe("checkPagespeed", () => {
  it("returns pageWeightKb as info issue", async () => {
    const siteDir = makeSiteDir();
    const distPath = path.join(siteDir, "astro/dist/index.html");
    const html = fs.readFileSync(distPath, "utf8");
    const result = await checkPagespeed({ route: "/", distHtmlPath: distPath, distHtml: html, distDir: path.join(siteDir, "astro/dist"), siteDir });
    expect(result.issues.some((i) => i.kind === "pagespeed-weight")).toBe(true);
    expect(result.issues[0].severity).toBe("info");
  });

  it("all issues are info severity only", async () => {
    const siteDir = makeSiteDir();
    const distPath = path.join(siteDir, "astro/dist/index.html");
    const html = fs.readFileSync(distPath, "utf8");
    const result = await checkPagespeed({ route: "/", distHtmlPath: distPath, distHtml: html, distDir: path.join(siteDir, "astro/dist"), siteDir });
    for (const issue of result.issues) expect(issue.severity).toBe("info");
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import type { CheckResult, PageContext } from "../types.ts";
import { countTag } from "../html.ts";

export async function checkPagespeed(page: PageContext): Promise<CheckResult> {
  const stats = fs.statSync(page.distHtmlPath);
  const pageWeightKb = Math.round(stats.size / 1024 * 10) / 10;
  const imgCount = countTag(page.distHtml, "img");
  const scriptCount = countTag(page.distHtml, "script");
  const linkCount = [...page.distHtml.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi)].length;
  return {
    issues: [
      { severity: "info", page: page.route, kind: "pagespeed-weight", detail: `Page weight: ${pageWeightKb} KB` },
      { severity: "info", page: page.route, kind: "pagespeed-assets", detail: `${imgCount} images, ${scriptCount} scripts, ${linkCount} stylesheets` },
    ],
  };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 2 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/pagespeed.ts \
        packages/clone-engine/test/buildreport/pagespeed.test.ts
git commit -m "feat(qa): pagespeed check — page weight + asset count (QA-T5)"
```

---

## Task 6: iframes check (clone-only)

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/iframes.ts`
- Create: `packages/clone-engine/test/buildreport/iframes.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { checkIframes } from "../../src/buildreport/checks/iframes.ts";
import { makeSiteDir, makeCaptureDir } from "./fixtures.ts";

describe("checkIframes", () => {
  it("no issues when source has no iframes", async () => {
    const siteDir = makeSiteDir();
    const captureDir = makeCaptureDir({ iframeSrcs: [] });
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkIframes({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir }, captureDir);
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when source iframe is absent from clone", async () => {
    const siteDir = makeSiteDir({ distHtml: "<p>no iframe</p>" });
    const captureDir = makeCaptureDir({ iframeSrcs: ["https://maps.google.com/embed?q=gym"] });
    const distPath = path.join(siteDir, "astro/dist/index.html");
    fs.writeFileSync(distPath, `<!doctype html><html><head><title>T</title></head><body><p>no iframe</p></body></html>`);
    const result = await checkIframes({ route: "/", distHtmlPath: distPath, distHtml: fs.readFileSync(distPath, "utf8"), distDir: path.join(siteDir, "astro/dist"), siteDir }, captureDir);
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "dropped-iframe")).toBe(true);
  });

  it("notes same-domain iframes (won't work off origin)", async () => {
    const siteDir = makeSiteDir({ distHtml: '<iframe src="https://sourcegym.com/booking"></iframe>' });
    const captureDir = makeCaptureDir({ iframeSrcs: ["https://sourcegym.com/booking"] });
    const distPath = path.join(siteDir, "astro/dist/index.html");
    fs.writeFileSync(distPath, `<!doctype html><html><head><title>T</title></head><body><iframe src="https://sourcegym.com/booking"></iframe></body></html>`);
    // Inject origin into capture so detector can identify same-domain
    const cap = JSON.parse(fs.readFileSync(path.join(captureDir, "capture.json"), "utf8"));
    cap.sourceOrigins = ["https://sourcegym.com"];
    fs.writeFileSync(path.join(captureDir, "capture.json"), JSON.stringify(cap));
    const result = await checkIframes({ route: "/", distHtmlPath: distPath, distHtml: fs.readFileSync(distPath, "utf8"), distDir: "", siteDir }, captureDir);
    expect(result.issues.some((i) => i.severity === "note" && i.kind === "same-domain-iframe")).toBe(true);
  });

  it("no issues when not called with source (skipped)", async () => {
    const siteDir = makeSiteDir();
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkIframes({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir }, undefined);
    expect(result.issues).toHaveLength(0);
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";
import type { CaptureJson } from "../../types.ts";
import { getIframeSrcs } from "../html.ts";

export async function checkIframes(page: PageContext, captureDir: string | undefined): Promise<CheckResult> {
  if (!captureDir) return { issues: [] };
  const cap = JSON.parse(fs.readFileSync(path.join(captureDir, "capture.json"), "utf8")) as CaptureJson & { sourceOrigins?: string[] };
  const sourceOrigins: string[] = cap.sourceOrigins ?? [];

  // Collect iframes from capture tree
  const sourceSrcs: string[] = [];
  const walk = (n: { tag?: string; attrs?: Record<string, string>; children?: unknown[] }) => {
    if (n.tag === "iframe" && n.attrs?.src) sourceSrcs.push(n.attrs.src);
    for (const c of n.children ?? []) walk(c as typeof n);
  };
  walk(cap.tree as Parameters<typeof walk>[0]);

  if (sourceSrcs.length === 0) return { issues: [] };

  const cloneSrcs = new Set(getIframeSrcs(page.distHtml));
  const issues = [];

  for (const src of sourceSrcs) {
    if (!cloneSrcs.has(src)) {
      issues.push({ severity: "blocker" as const, page: page.route, kind: "dropped-iframe", detail: `iframe src="${src}" present in source was dropped in clone` });
    } else {
      const isSameDomain = sourceOrigins.some((origin) => src.startsWith(origin));
      if (isSameDomain) {
        issues.push({ severity: "note" as const, page: page.route, kind: "same-domain-iframe", detail: `iframe src="${src}" is on the source's domain — may not load off-origin` });
      }
    }
  }
  return { issues };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 4 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/iframes.ts \
        packages/clone-engine/test/buildreport/iframes.test.ts
git commit -m "feat(qa): iframes check — preserve+verify, same-domain note (QA-T6)"
```

---

## Task 7: fidelity check (clone-only)

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/fidelity.ts`
- Create: `packages/clone-engine/test/buildreport/fidelity.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeFidelityPct } from "../../src/buildreport/checks/fidelity.ts";
import { TINY_PNG } from "./fixtures.ts";

describe("computeFidelityPct", () => {
  it("identical images → 100%", async () => {
    const pct = computeFidelityPct({ matchPct: 100, totalPx: 100, diffPx: 0 });
    expect(pct).toBe(100);
  });

  it("complete mismatch → 0%", async () => {
    const pct = computeFidelityPct({ matchPct: 0, totalPx: 100, diffPx: 100 });
    expect(pct).toBe(0);
  });

  it("partial match is passed through", async () => {
    const pct = computeFidelityPct({ matchPct: 75.5, totalPx: 1000, diffPx: 245 });
    expect(pct).toBeCloseTo(75.5, 1);
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import type { CheckResult, PageContext } from "../types.ts";
import type { PixelDiffResult } from "../../pixel.ts";
import { pixelDiff } from "../../pixel.ts";
import { renderSnapshot } from "../../edit/snapshot.ts";

/** Pure helper — maps a PixelDiffResult to a 0-100 fidelity percentage. */
export function computeFidelityPct(result: PixelDiffResult): number {
  return result.matchPct;
}

/**
 * Pixel-diff the built clone homepage against the source capture screenshot.
 * Returns a fidelity % as info (never a blocker — expected divergence from fallback fonts etc.).
 */
export async function checkFidelity(
  page: PageContext,
  captureDir: string,
  browser: Browser,
  width: number,
): Promise<{ issues: CheckResult["issues"]; fidelityPct: number }> {
  const sourcePngPath = path.join(captureDir, "source-desktop.png");
  if (!fs.existsSync(sourcePngPath)) {
    return { issues: [{ severity: "info", page: page.route, kind: "fidelity-skip", detail: "source-desktop.png not found — fidelity check skipped" }], fidelityPct: 0 };
  }

  const snap = await renderSnapshot(browser, { dir: page.siteDir }, { width });
  if (!snap.screenshot) {
    return { issues: [{ severity: "info", page: page.route, kind: "fidelity-skip", detail: "Clone screenshot failed" }], fidelityPct: 0 };
  }

  const sourcePng = fs.readFileSync(sourcePngPath);
  const result = await pixelDiff(browser, sourcePng, snap.screenshot);
  const pct = computeFidelityPct(result);

  return {
    issues: [{ severity: "info", page: page.route, kind: "fidelity", detail: `Pixel fidelity vs source: ${pct.toFixed(1)}%` }],
    fidelityPct: pct,
  };
}
```

- [ ] **Step 4 — run to verify it passes (unit tests only)** → Expected: 3 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/fidelity.ts \
        packages/clone-engine/test/buildreport/fidelity.test.ts
git commit -m "feat(qa): fidelity check — pixel diff + computeFidelityPct (QA-T7)"
```

---

## Task 8: layout-breaks check (integration — needs Playwright)

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/layout-breaks.ts`
- Create: `packages/clone-engine/test/buildreport/layout-breaks.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLayoutBreaks } from "../../src/buildreport/checks/layout-breaks.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");
const REPO = path.resolve(PKG, "../../..");
function findAstroModules(): string | null {
  const candidates = [process.env.ASTRO_MODULES, path.join(REPO, "milo/page-clone-spike/out-project-page/astro/node_modules")].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (require("fs").existsSync(require("path").join(c, ".bin/astro"))) return c; } catch { /**/ }
  }
  return null;
}
const ASTRO_MODULES = findAstroModules();

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { await browser?.close(); });

describe.skipIf(!ASTRO_MODULES)("checkLayoutBreaks", () => {
  it("no layout issues on the speakeasy golden (sections don't overlap)", async () => {
    const goldenDir = path.join(PKG, "test/golden/speakeasy");
    // The golden has a projected site dir; we run layout check on it
    const result = await checkLayoutBreaks(
      { route: "/", distHtmlPath: "", distHtml: "", distDir: "", siteDir: goldenDir },
      browser, 1440,
    );
    // Speakeasy golden should have no layout breaks at 1440
    expect(result.issues.filter((i) => i.severity === "blocker")).toHaveLength(0);
  }, 120_000);
});
```

- [ ] **Step 2 — run to verify it fails (or skips if no ASTRO_MODULES)**
- [ ] **Step 3 — implement**

```ts
import type { Browser } from "playwright";
import type { CheckResult, PageContext } from "../types.ts";
import { overlaps, OVERLAP_TOLERANCE_PX } from "../../edit/verify.ts";
import { renderSnapshot } from "../../edit/snapshot.ts";

export async function checkLayoutBreaks(page: PageContext, browser: Browser, width: number): Promise<CheckResult> {
  const snap = await renderSnapshot(browser, { dir: page.siteDir }, { width });
  const issues = [];

  // Check every pair of sections for overlap (same logic as verify.ts structural check)
  const sections = Object.entries(snap.sectionBoxes ?? {});
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const [nameA, boxA] = sections[i];
      const [nameB, boxB] = sections[j];
      if (overlaps(boxA, boxB, OVERLAP_TOLERANCE_PX)) {
        issues.push({
          severity: "blocker" as const,
          page: page.route,
          section: nameA,
          kind: "layout-break",
          detail: `Section "${nameA}" overlaps "${nameB}" at ${width}px viewport`,
        });
      }
    }
  }
  return { issues };
}
```

Note: `renderSnapshot` returns a `RenderSnapshot` with `order: string[]`. The section boxes are available through `sectionListOf` → compare to see if `sectionBoxes` is on the snapshot. If not, call `sectionListOf` separately to get boxes. Check `src/edit/snapshot.ts` for the exact shape and adjust the implementation — the key is reusing `overlaps()` from `verify.ts`.

- [ ] **Step 4 — run to verify it passes (or skips)** → Expected: 1 passed or skipped
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/layout-breaks.ts \
        packages/clone-engine/test/buildreport/layout-breaks.test.ts
git commit -m "feat(qa): layout-breaks check — reuses verify.ts overlaps() (QA-T8)"
```

---

## Task 9: font-fallback check

**Files:**
- Create: `packages/clone-engine/src/buildreport/checks/font-fallback.ts`
- Create: `packages/clone-engine/test/buildreport/font-fallback.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { checkFontFallback } from "../../src/buildreport/checks/font-fallback.ts";
import { makeSiteDir } from "./fixtures.ts";

describe("checkFontFallback", () => {
  it("no issues when brand font is referenced in global.css", async () => {
    const siteDir = makeSiteDir({ brandFonts: [{ slot: "display", family: "Bebas Neue" }] });
    // global.css already has @font-face for Bebas Neue from makeSiteDir
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkFontFallback({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    expect(result.issues.filter((i) => i.kind === "font-fallback")).toHaveLength(0);
  });

  it("note when brand font family is not referenced anywhere in global.css", async () => {
    const siteDir = makeSiteDir({ brandFonts: [{ slot: "display", family: "MyMissingFont" }] });
    // Overwrite global.css to not reference the font
    fs.writeFileSync(path.join(siteDir, "astro/src/styles/global.css"), "/* empty */");
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkFontFallback({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    expect(result.issues.some((i) => i.severity === "note" && i.kind === "font-fallback")).toBe(true);
  });

  it("all issues are note severity (never blocks)", async () => {
    const siteDir = makeSiteDir({ brandFonts: [{ slot: "display", family: "Gone" }] });
    fs.writeFileSync(path.join(siteDir, "astro/src/styles/global.css"), "/* empty */");
    const html = fs.readFileSync(path.join(siteDir, "astro/dist/index.html"), "utf8");
    const result = await checkFontFallback({ route: "/", distHtmlPath: "", distHtml: html, distDir: "", siteDir });
    for (const issue of result.issues) expect(issue.severity).not.toBe("blocker");
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { CheckResult, PageContext } from "../types.ts";

interface BrandJson { fonts: { slot: string; family: string }[] }

export async function checkFontFallback(page: PageContext): Promise<CheckResult> {
  const brandPath = path.join(page.siteDir, "astro", "brand.json");
  if (!fs.existsSync(brandPath)) return { issues: [] };
  const brand = JSON.parse(fs.readFileSync(brandPath, "utf8")) as BrandJson;
  const cssPath = path.join(page.siteDir, "astro", "src", "styles", "global.css");
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";

  const issues = [];
  for (const font of brand.fonts) {
    if (!css.toLowerCase().includes(font.family.toLowerCase())) {
      issues.push({
        severity: "note" as const,
        page: page.route,
        kind: "font-fallback",
        detail: `Brand font "${font.family}" (slot: ${font.slot}) not found in global.css — may fall back to system font`,
      });
    }
  }
  return { issues };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 3 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/checks/font-fallback.ts \
        packages/clone-engine/test/buildreport/font-fallback.test.ts
git commit -m "feat(qa): font-fallback check (QA-T9)"
```

---

## Task 10: Inspector orchestrator

**Files:**
- Create: `packages/clone-engine/src/buildreport/inspector.ts`
- Create: `packages/clone-engine/test/buildreport/inspector.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { inspectSite } from "../../src/buildreport/inspector.ts";
import { makeSiteDir } from "./fixtures.ts";
import fs from "node:fs"; import path from "node:path";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { await browser?.close(); });

describe("inspectSite", () => {
  it("returns SHIP verdict for a clean site", async () => {
    const siteDir = makeSiteDir();
    const report = await inspectSite({ siteDir, browser });
    // Fixture site has title + desc + h1 + sections, no broken assets, no dead links
    expect(report.verdict).toBe("SHIP");
    expect(report.blockerCount).toBe(0);
    expect(typeof report.generatedAt).toBe("string");
  });

  it("returns NEEDS_FIXES when there is a blocker issue", async () => {
    const siteDir = makeSiteDir({ distHtml: '<img src="/nonexistent.png">' });
    // Also need a valid dist/index.html — overwrite fixture
    const distPath = path.join(siteDir, "astro/dist/index.html");
    fs.writeFileSync(distPath, '<!doctype html><html><head><title>T</title><meta name="description" content="D"></head><body><h1>H</h1><img src="/nonexistent.png"></body></html>');
    const report = await inspectSite({ siteDir, browser });
    expect(report.verdict).toBe("NEEDS_FIXES");
    expect(report.blockerCount).toBeGreaterThan(0);
  }, 30_000);

  it("verdict SHIP with source provided when no regressions", async () => {
    const siteDir = makeSiteDir();
    const { makeCaptureDir } = await import("./fixtures.ts");
    const captureDir = makeCaptureDir({ title: "Test Site", description: "A test site" });
    const report = await inspectSite({ siteDir, browser, source: { captureDir } });
    expect(report.verdict).toBe("SHIP");
  }, 30_000);
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import fs from "node:fs";
import path from "node:path";
import type { InspectOpts, SiteReport, PageReport, Issue } from "./types.ts";
import type { SiteManifest } from "../types.ts";
import { checkBrokenAssets } from "./checks/broken-assets.ts";
import { checkContentBlocks } from "./checks/content-blocks.ts";
import { checkDeadLinks } from "./checks/dead-links.ts";
import { checkSeo } from "./checks/seo.ts";
import { checkPagespeed } from "./checks/pagespeed.ts";
import { checkIframes } from "./checks/iframes.ts";
import { checkFidelity } from "./checks/fidelity.ts";
import { checkLayoutBreaks } from "./checks/layout-breaks.ts";
import { checkFontFallback } from "./checks/font-fallback.ts";

export async function inspectSite(opts: InspectOpts): Promise<SiteReport> {
  const { siteDir, browser, width = 1440, source } = opts;
  const manifest = JSON.parse(fs.readFileSync(path.join(siteDir, "site.json"), "utf8")) as SiteManifest;

  const allIssues: Issue[] = [];
  const pageReports: PageReport[] = [];

  for (const page of manifest.pages) {
    const distDir = path.join(siteDir, "astro", "dist");
    const distHtmlPath = path.join(distDir, "index.html");
    if (!fs.existsSync(distHtmlPath)) continue;
    const distHtml = fs.readFileSync(distHtmlPath, "utf8");
    const ctx = { route: page.route, distHtmlPath, distHtml, distDir, siteDir };

    const results = await Promise.all([
      checkBrokenAssets(ctx),
      checkContentBlocks(ctx),
      checkDeadLinks(ctx),
      checkSeo({ ...ctx, source }),
      checkPagespeed(ctx),
      checkFontFallback(ctx),
      source ? checkIframes(ctx, source.captureDir) : Promise.resolve({ issues: [] }),
      checkLayoutBreaks(ctx, browser, width),
    ]);

    const pageIssues = results.flatMap((r) => r.issues);

    let fidelityPct: number | undefined;
    if (source) {
      const fid = await checkFidelity(ctx, source.captureDir, browser, width);
      pageIssues.push(...fid.issues);
      fidelityPct = fid.fidelityPct;
    }

    const weightIssue = pageIssues.find((i) => i.kind === "pagespeed-weight");
    const pageWeightKb = weightIssue ? parseFloat(weightIssue.detail.replace(/[^0-9.]/g, "")) : 0;

    allIssues.push(...pageIssues);
    pageReports.push({ route: page.route, issues: pageIssues, fidelityPct, pageWeightKb });
  }

  const blockerCount = allIssues.filter((i) => i.severity === "blocker").length;
  const noteCount = allIssues.filter((i) => i.severity === "note").length;
  const infoCount = allIssues.filter((i) => i.severity === "info").length;

  return {
    verdict: blockerCount === 0 ? "SHIP" : "NEEDS_FIXES",
    blockerCount,
    noteCount,
    infoCount,
    issues: allIssues,
    pages: pageReports,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 3 passed (some may require real browser)
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/inspector.ts \
        packages/clone-engine/test/buildreport/inspector.test.ts
git commit -m "feat(qa): inspector orchestrator — all checks → SiteReport + verdict (QA-T10)"
```

---

## Task 11: HTML/JSON renderer

**Files:**
- Create: `packages/clone-engine/src/buildreport/render.ts`
- Create: `packages/clone-engine/test/buildreport/render.test.ts`

- [ ] **Step 1 — write failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderSiteReport } from "../../src/buildreport/render.ts";
import type { SiteReport } from "../../src/buildreport/types.ts";

const makeReport = (verdict: "SHIP" | "NEEDS_FIXES", blockers: number): SiteReport => ({
  verdict, blockerCount: blockers, noteCount: 0, infoCount: 2,
  issues: blockers > 0 ? [{ severity: "blocker", page: "/", kind: "broken-asset", detail: "logo.png missing" }] : [],
  pages: [{ route: "/", issues: [], pageWeightKb: 42 }],
  generatedAt: "2026-08-02T00:00:00.000Z",
});

describe("renderSiteReport", () => {
  it("SHIP verdict shows green indicator", () => {
    const html = renderSiteReport(makeReport("SHIP", 0));
    expect(html).toContain("SHIP");
    expect(html).toContain("zero blockers");
  });

  it("NEEDS_FIXES verdict shows red indicator and blocker count", () => {
    const html = renderSiteReport(makeReport("NEEDS_FIXES", 1));
    expect(html).toContain("NEEDS_FIXES");
    expect(html).toContain("1 blocker");
    expect(html).toContain("logo.png missing");
  });

  it("produces valid HTML with doctype", () => {
    const html = renderSiteReport(makeReport("SHIP", 0));
    expect(html.trim().toLowerCase()).toMatch(/^<!doctype html>/);
  });

  it("includes page weight in the output", () => {
    const html = renderSiteReport(makeReport("SHIP", 0));
    expect(html).toContain("42");
  });
});
```

- [ ] **Step 2 — run to verify it fails**
- [ ] **Step 3 — implement**

```ts
import type { SiteReport, Issue } from "./types.ts";

function severity(s: Issue["severity"]): string {
  return s === "blocker" ? "🔴" : s === "note" ? "🟡" : "ℹ️";
}

export function renderSiteReport(report: SiteReport): string {
  const verdictColor = report.verdict === "SHIP" ? "#22c55e" : "#ef4444";
  const verdictMsg = report.verdict === "SHIP"
    ? "✅ SHIP — zero blockers"
    : `⚠️ NEEDS_FIXES — ${report.blockerCount} blocker${report.blockerCount !== 1 ? "s" : ""}`;

  const issueRows = report.issues.map((i) =>
    `<tr><td>${severity(i.severity)} ${i.severity}</td><td>${i.page}</td><td>${i.section ?? ""}</td><td>${i.kind}</td><td>${i.detail}</td></tr>`
  ).join("");

  const pageRows = report.pages.map((p) =>
    `<tr><td>${p.route}</td><td>${p.pageWeightKb} KB</td><td>${p.issues.filter((i) => i.severity === "blocker").length}</td><td>${p.fidelityPct != null ? p.fidelityPct.toFixed(1) + "%" : "—"}</td></tr>`
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site Build Report — ${report.generatedAt.slice(0, 10)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f9fafb; }
  .verdict { font-size: 2rem; font-weight: bold; color: ${verdictColor}; padding: 1rem; background: white; border-radius: 8px; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .summary { display: flex; gap: 1rem; margin-bottom: 1.5rem; }
  .chip { padding: .4rem .8rem; border-radius: 6px; font-size: .9rem; font-weight: 600; }
  .blocker { background: #fee2e2; color: #991b1b; }
  .note { background: #fef9c3; color: #854d0e; }
  .info { background: #dbeafe; color: #1e40af; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 1.5rem; }
  th { background: #f3f4f6; text-align: left; padding: .6rem .8rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  td { padding: .6rem .8rem; border-top: 1px solid #f3f4f6; font-size: .85rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; color: #374151; }
</style>
</head>
<body>
<div class="verdict">${verdictMsg}</div>
<div class="summary">
  <span class="chip blocker">${report.blockerCount} blocker${report.blockerCount !== 1 ? "s" : ""}</span>
  <span class="chip note">${report.noteCount} note${report.noteCount !== 1 ? "s" : ""}</span>
  <span class="chip info">${report.infoCount} info</span>
  <span style="margin-left:auto;font-size:.8rem;color:#6b7280">Generated ${report.generatedAt}</span>
</div>
<h2>Issues</h2>
<table>
  <thead><tr><th>Severity</th><th>Page</th><th>Section</th><th>Check</th><th>Detail</th></tr></thead>
  <tbody>${issueRows || "<tr><td colspan='5' style='color:#6b7280'>No issues found.</td></tr>"}</tbody>
</table>
<h2>Pages</h2>
<table>
  <thead><tr><th>Route</th><th>Weight</th><th>Blockers</th><th>Fidelity</th></tr></thead>
  <tbody>${pageRows}</tbody>
</table>
</body>
</html>`;
}
```

- [ ] **Step 4 — run to verify it passes** → Expected: 4 passed
- [ ] **Step 5 — commit**
```bash
git add packages/clone-engine/src/buildreport/render.ts \
        packages/clone-engine/test/buildreport/render.test.ts
git commit -m "feat(qa): HTML/JSON report renderer — verdict + punch-list (QA-T11)"
```

---

## Task 12: Wire into `buildSiteAuto` + export from engine API

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts`
- Modify: `packages/clone-engine/src/index.ts`

- [ ] **Step 1 — add import + call in orchestrate.ts**

In `src/orchestrate.ts`, after the `injectTrackerIntoSite(fullSite)` call, add:

```ts
import { inspectSite } from "./qa/inspector.ts";
import { renderSiteReport } from "./qa/render.ts";
```

Then after `emit({ type: "assemble.done", ... })` and before `if (opts.reportOut ...)`:

```ts
  // Run the site build report (ship/no-ship gate) if browser available.
  if (opts.browser && opts.reportOut) {
    const siteReport = await inspectSite({ siteDir: fullSite, browser: opts.browser });
    const siteReportHtml = renderSiteReport(siteReport);
    const siteReportPath = opts.reportOut.replace(/\.html?$/, "-site-report.html");
    const siteReportJsonPath = siteReportPath.replace(/\.html$/, ".json");
    fs.writeFileSync(siteReportPath, siteReportHtml);
    fs.writeFileSync(siteReportJsonPath, JSON.stringify(siteReport, null, 2) + "\n");
    emit({ type: "run.completed" as never, verdict: siteReport.verdict, blockerCount: siteReport.blockerCount });
    console.log(`\nSite report: ${siteReport.verdict} (${siteReport.blockerCount} blockers) → ${siteReportPath}`);
  }
```

Note: `BuildSiteAutoOpts` needs a `browser?: Browser` field. Add it:
```ts
export interface BuildSiteAutoOpts {
  // ... existing fields ...
  browser?: Browser;  // if provided, runs the site build report after assembly
}
```

- [ ] **Step 2 — update engine public API in index.ts**

Add to `src/index.ts`:
```ts
export { inspectSite } from "./qa/inspector.ts";
export { renderSiteReport } from "./qa/render.ts";
export type { SiteReport, Issue, PageReport, IssueSeverity, InspectOpts } from "./qa/types.ts";
```

- [ ] **Step 3 — typecheck**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean

- [ ] **Step 4 — commit**
```bash
git add packages/clone-engine/src/orchestrate.ts \
        packages/clone-engine/src/index.ts
git commit -m "feat(qa): wire site build report into buildSiteAuto; export from engine API (QA-T12)"
```

---

## Task 13: Full suite green + tsc clean

- [ ] **Step 1 — run full qa test suite**
  - Run: `cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/buildreport/`
  - Expected: all pass (integration tests with `skipIf(!ASTRO_MODULES)` either pass or skip)

- [ ] **Step 2 — run full clone-engine suite**
  - Run: `pnpm vitest run --no-file-parallelism` → Expected: all pre-existing tests still pass

- [ ] **Step 3 — typecheck**
  - Run: `node_modules/.bin/tsc --noEmit` → Expected: clean

- [ ] **Step 4 — commit**
```bash
git commit --allow-empty -m "chore(qa): full-suite green + tsc clean (QA-T13)"
```

---

## Done when

- `inspectSite(opts)` runs on any built site and returns `SiteReport` with a `SHIP`/`NEEDS_FIXES` verdict
- All 9 checks are implemented and independently unit-tested with fixtures
- Clone-fidelity checks (fidelity, iframes, SEO regression) only run when `opts.source` provided
- `buildSiteAuto` writes `*-site-report.html` + `*-site-report.json` when a browser + reportOut are provided
- Full test suite green, tsc clean, no engine primitives modified beyond the `overlaps` export

---

## Self-review

**Spec coverage:**
- broken-assets ✅ T1
- content-blocks ✅ T2
- dead-links ✅ T3
- SEO + regressions ✅ T4
- pagespeed ✅ T5
- iframes + same-domain note ✅ T6
- fidelity (pixel diff) ✅ T7
- layout-breaks ✅ T8
- font-fallback ✅ T9
- Inspector orchestrator ✅ T10
- HTML/JSON renderer ✅ T11
- buildSiteAuto wiring ✅ T12

**Type consistency:** `PageContext`, `CheckResult`, `Issue`, `SiteReport`, `InspectOpts` are defined once in `types.ts` and used identically across all tasks. `checkSeo` takes `PageContext & Pick<InspectOpts, "source">` — that needs to be simplified: either add `source` to `PageContext` or pass it separately. The cleanest fix: add `source?: InspectOpts["source"]` to `PageContext` so every check has access to it without parameter surgery. Tasks 4 and 6 use `source` — update both implementations to read it from `ctx.source`.

**`checkLayoutBreaks` note:** The implementation references `snap.sectionBoxes` which may not exist on `RenderSnapshot`. Check `src/edit/snapshot.ts` for the actual field — it may be `snap.order` (section names) + a separate box measurement call. Adjust the implementation to use `sectionListOf` if needed.
