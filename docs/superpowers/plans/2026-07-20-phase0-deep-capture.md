# Phase 0: Deep Capture + Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `apps/studio`'s shallow capture into a deep-capture + asset pipeline that emits a DOM-segmented, per-section, self-hosted-asset capture bundle for any URL, validated against the golden corpus.

**Architecture:** Split the monolithic `capture.mjs` into focused, testable modules — `segment.mjs` (DOM-based section segmentation, injected into the page), `fonts.mjs` (resolve `@font-face`/loaded fonts), `assets.mjs` (map + download + rewrite asset refs) — orchestrated by a slimmed `capture.mjs`. Tests are deterministic: they drive real Playwright/Chromium against **checked-in static HTML fixtures** that encode known structures (including the Speakeasy collapse), plus a corpus integration test asserting ground-truth facts on the three reference sites.

**Tech Stack:** Node 24 ESM (`.mjs`), Playwright (already installed), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-template-ir-design.md` (Phase 0 section + confirmed corpus-recon requirements).

---

## File Structure

- Create: `apps/studio/src/segment.mjs` — exports `segmentPage` (self-contained browser-context function returning a clean section list by walking the DOM spine and descending shell wrappers).
- Create: `apps/studio/src/fonts.mjs` — exports `resolveFonts` (browser-context: `@font-face` rules + `document.fonts`) and Node-side `fontFileUrls(faces)`.
- Create: `apps/studio/src/assets.mjs` — Node-side `collectAssetUrls(bundle)`, `rewriteRefs(bundle, map)`, `downloadAssets(urls, dir)`.
- Modify: `apps/studio/src/capture.mjs` — orchestrator; imports the three modules, keeps screenshot passes, writes enriched bundle.
- Create: `apps/studio/test/segment.test.mjs`, `apps/studio/test/fonts.test.mjs`, `apps/studio/test/assets.test.mjs`, `apps/studio/test/corpus.test.mjs`.
- Create fixtures: `apps/studio/test/fixtures/three-sections.html`, `apps/studio/test/fixtures/nested-wrapper.html`, `apps/studio/test/fixtures/fontface.html`.
- Modify: `apps/studio/package.json` — add `vitest` devDep + `test` script.

---

### Task 1: Vitest scaffold + first segmentation fixture (red)

**Files:**
- Modify: `apps/studio/package.json`
- Create: `apps/studio/test/fixtures/three-sections.html`
- Create: `apps/studio/test/segment.test.mjs`

- [ ] **Step 1: Add vitest + test script to package.json**

Replace `apps/studio/package.json` with:

```json
{
  "name": "studio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "capture": "node src/capture.mjs",
    "test": "vitest run"
  },
  "dependencies": {
    "playwright": "^1.49.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `cd ~/pushpress/milo && pnpm install`
Expected: vitest added to `apps/studio`.

- [ ] **Step 3: Create the three-sections fixture**

`apps/studio/test/fixtures/three-sections.html` — three obvious top-level sections directly under body:

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: sans-serif; }
  section { padding: 40px; }
  .a { height: 400px; background: #eee; }
  .b { height: 500px; background: #fff; }
  .c { height: 300px; background: #222; color: #fff; }
</style></head>
<body>
  <section class="a"><h2>Alpha</h2><p>one</p></section>
  <section class="b"><h2>Bravo</h2><p>two</p></section>
  <section class="c"><h2>Charlie</h2><p>three</p></section>
</body></html>
```

- [ ] **Step 4: Write the failing test**

`apps/studio/test/segment.test.mjs`:

```js
import { test, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { segmentPage } from "../src/segment.mjs";

const fixture = (name) =>
  "file://" + path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

let browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

test("segments three top-level sections in order", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(fixture("three-sections.html"));
  const sections = await page.evaluate(segmentPage);
  await page.close();
  expect(sections).toHaveLength(3);
  expect(sections.map((s) => s.heading)).toEqual(["Alpha", "Bravo", "Charlie"]);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test`
Expected: FAIL — `Cannot find module '../src/segment.mjs'`.

- [ ] **Step 6: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/package.json apps/studio/test pnpm-lock.yaml && \
git commit -m "test(studio): vitest scaffold + failing three-section segmentation test"
```

---

### Task 2: Implement segmentation (green)

**Files:**
- Create: `apps/studio/src/segment.mjs`

- [ ] **Step 1: Implement `segmentPage`**

`apps/studio/src/segment.mjs` — a single self-contained function (no imports/closures) so Playwright can serialize it into the page. It finds the content "spine" by descending single-child shell wrappers, then emits the spine's direct children as sections:

```js
/**
 * Browser-context section segmentation. Injected via page.evaluate, so it must
 * be fully self-contained (helpers nested inside, no external references).
 * Fixes the flat `body > *, section` heuristic that collapsed on real sites:
 * it descends shell wrappers (one meaningful child) so a giant wrapper does not
 * masquerade as one section, and it emits *direct children of the spine* so
 * nested/overlapping duplicates never appear.
 */
export const segmentPage = () => {
  const MIN_H = 80;
  const tall = (el) =>
    [...el.children].filter((c) => c.getBoundingClientRect().height >= MIN_H);
  const isShell = (el) => tall(el).length === 1;
  const descend = (el) => {
    let node = el;
    let guard = 0;
    while (isShell(node) && guard++ < 20) {
      const next = tall(node)[0];
      if (!next || next === node) break;
      node = next;
    }
    return node;
  };
  const spine = descend(document.querySelector("main") || document.body);
  const out = [];
  for (const el of spine.children) {
    const r = el.getBoundingClientRect();
    const h = Math.round(r.height);
    if (h < MIN_H) continue;
    const cs = getComputedStyle(el);
    out.push({
      tag: el.tagName,
      cls: (el.className?.toString() || "").slice(0, 140),
      y: Math.round(r.y + window.scrollY),
      height: h,
      bg: cs.backgroundColor,
      padding: cs.padding,
      heading: el.querySelector("h1,h2,h3")?.textContent?.trim().slice(0, 100) ?? null,
      childCount: el.children.length,
    });
  }
  return out;
};
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test`
Expected: PASS — "segments three top-level sections in order".

- [ ] **Step 3: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/src/segment.mjs && \
git commit -m "feat(studio): DOM-spine section segmentation"
```

---

### Task 3: Nested-wrapper regression test — the Speakeasy collapse (red)

**Files:**
- Create: `apps/studio/test/fixtures/nested-wrapper.html`
- Modify: `apps/studio/test/segment.test.mjs`

- [ ] **Step 1: Create the nested-wrapper fixture**

Encodes Speakeasy's failure shape: the real sections are buried under two single-child shell wrappers. The old heuristic returned one monster block; the new one must descend and return the 3 real sections.

`apps/studio/test/fixtures/nested-wrapper.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: sans-serif; }
  .page-wrapper, .content { display: block; }
  section { padding: 40px; }
  .a { height: 900px; background: #eee; }
  .b { height: 1200px; background: #fff; }
  .c { height: 600px; background: #111; color: #fff; }
</style></head>
<body>
  <div class="page-wrapper">
    <div class="content">
      <section class="a"><h1>Hero Headline</h1></section>
      <section class="b"><h2>Three Steps</h2></section>
      <section class="c"><h2>Stories of Glory</h2></section>
    </div>
  </div>
</body></html>
```

- [ ] **Step 2: Add the failing test**

Append to `apps/studio/test/segment.test.mjs`:

```js
test("descends shell wrappers instead of returning one monster block", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(fixture("nested-wrapper.html"));
  const sections = await page.evaluate(segmentPage);
  await page.close();
  expect(sections).toHaveLength(3);
  expect(sections.map((s) => s.heading)).toEqual([
    "Hero Headline",
    "Three Steps",
    "Stories of Glory",
  ]);
  // No section may span (almost) the whole page — that was the collapse bug.
  const pageHeight = 900 + 1200 + 600;
  expect(Math.max(...sections.map((s) => s.height))).toBeLessThan(pageHeight * 0.9);
});
```

- [ ] **Step 3: Run to verify current behavior**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test`
Expected: PASS if Task 2's `descend` already handles two shell layers. If FAIL (e.g. monster block returned), continue to Task 4; if PASS, mark Task 4 steps 1-2 as verified and commit anyway.

- [ ] **Step 4: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/test && \
git commit -m "test(studio): nested-wrapper regression for section collapse"
```

---

### Task 4: Harden descent if the regression test failed (green)

**Files:**
- Modify: `apps/studio/src/segment.mjs`

- [ ] **Step 1: If Task 3 passed, skip to Step 3.** Otherwise, the spine picked a wrapper whose single tall child is itself a section-holder. Fix `descend` to stop when the candidate child holds multiple sections. Replace the `descend` function body in `segment.mjs` with:

```js
  const descend = (el) => {
    let node = el;
    let guard = 0;
    while (guard++ < 20) {
      if (!isShell(node)) break;
      const next = tall(node)[0];
      if (!next || next === node) break;
      // Stop if descending would hide multiple real sections one level down.
      if (tall(next).length > 1 && tall(node).length === 1) { node = next; continue; }
      node = next;
    }
    return node;
  };
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test`
Expected: PASS — both segmentation tests.

- [ ] **Step 3: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/src/segment.mjs && \
git commit -m "fix(studio): descend to the multi-section spine"
```

---

### Task 5: Font resolution — `@font-face` + loaded fonts (red → green)

**Files:**
- Create: `apps/studio/src/fonts.mjs`
- Create: `apps/studio/test/fixtures/fontface.html`
- Create: `apps/studio/test/fonts.test.mjs`

- [ ] **Step 1: Create the fontface fixture**

Declares a font via `@font-face` (not a `<link>`), mirroring Speakeasy:

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: "Nourd Light Font";
    font-style: normal;
    font-weight: 300;
    src: url("/fonts/nourd-light.woff2") format("woff2");
  }
  h1 { font-family: "Nourd Light Font", sans-serif; }
</style></head>
<body><h1>Speakeasy</h1></body></html>
```

- [ ] **Step 2: Write the failing test**

`apps/studio/test/fonts.test.mjs`:

```js
import { test, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveFonts, fontFileUrls } from "../src/fonts.mjs";

const fixture = (name) =>
  "file://" + path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

let browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

test("resolves @font-face families even without <link> tags", async () => {
  const page = await browser.newPage();
  await page.goto(fixture("fontface.html"));
  const fonts = await page.evaluate(resolveFonts);
  await page.close();
  expect(fonts.faces.map((f) => f.family)).toContain("Nourd Light Font");
  const urls = fontFileUrls(fonts.faces, fixture("fontface.html"));
  expect(urls.some((u) => u.endsWith("nourd-light.woff2"))).toBe(true);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test fonts`
Expected: FAIL — `Cannot find module '../src/fonts.mjs'`.

- [ ] **Step 4: Implement `fonts.mjs`**

```js
/** Browser-context: enumerate @font-face rules and loaded fonts. Self-contained. */
export const resolveFonts = () => {
  const faces = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (rule.constructor.name !== "CSSFontFaceRule") continue;
      faces.push({
        family: rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim(),
        weight: rule.style.getPropertyValue("font-weight") || "normal",
        style: rule.style.getPropertyValue("font-style") || "normal",
        src: rule.style.getPropertyValue("src"),
      });
    }
  }
  const loaded = [...(document.fonts || [])].map((f) => ({
    family: f.family.replace(/["']/g, ""), weight: f.weight, style: f.style, status: f.status,
  }));
  return { faces, loaded };
};

/** Node-side: extract absolute font file URLs from face `src` declarations. */
export function fontFileUrls(faces, baseUrl) {
  const out = [];
  for (const f of faces) {
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let m;
    while ((m = re.exec(f.src || "")) !== null) {
      try { out.push(new URL(m[1], baseUrl).href); } catch { /* skip data: and malformed */ }
    }
  }
  return [...new Set(out)];
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test fonts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/src/fonts.mjs apps/studio/test/fonts.test.mjs apps/studio/test/fixtures/fontface.html && \
git commit -m "feat(studio): resolve @font-face + loaded fonts"
```

---

### Task 6: Asset map + ref rewriting (pure, red → green)

**Files:**
- Create: `apps/studio/src/assets.mjs`
- Create: `apps/studio/test/assets.test.mjs`

- [ ] **Step 1: Write the failing test**

`apps/studio/test/assets.test.mjs`:

```js
import { test, expect } from "vitest";
import { collectAssetUrls, rewriteRefs } from "../src/assets.mjs";

const bundle = {
  images: [{ src: "https://x.com/a.webp", w: 100, h: 100, alt: "" },
           { src: "https://x.com/a.webp", w: 100, h: 100, alt: "" }],
  fontUrls: ["https://x.com/f.woff2"],
};

test("collectAssetUrls dedupes across images and fonts", () => {
  expect(collectAssetUrls(bundle).sort()).toEqual(
    ["https://x.com/a.webp", "https://x.com/f.woff2"].sort(),
  );
});

test("rewriteRefs swaps remote urls for local paths", () => {
  const map = { "https://x.com/a.webp": "assets/a.webp", "https://x.com/f.woff2": "assets/f.woff2" };
  const out = rewriteRefs(bundle, map);
  expect(out.images[0].src).toBe("assets/a.webp");
  expect(out.fontUrls[0]).toBe("assets/f.woff2");
  // original untouched (pure)
  expect(bundle.images[0].src).toBe("https://x.com/a.webp");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test assets`
Expected: FAIL — `Cannot find module '../src/assets.mjs'`.

- [ ] **Step 3: Implement `assets.mjs`**

```js
import fs from "node:fs";
import path from "node:path";

/** All unique remote asset URLs referenced by a capture bundle. */
export function collectAssetUrls(bundle) {
  const urls = new Set();
  for (const img of bundle.images ?? []) if (img.src?.startsWith("http")) urls.add(img.src);
  for (const u of bundle.fontUrls ?? []) if (u?.startsWith("http")) urls.add(u);
  return [...urls];
}

/** Return a deep-ish copy of the bundle with remote urls replaced by local paths. */
export function rewriteRefs(bundle, map) {
  const swap = (u) => map[u] ?? u;
  return {
    ...bundle,
    images: (bundle.images ?? []).map((i) => ({ ...i, src: swap(i.src) })),
    fontUrls: (bundle.fontUrls ?? []).map(swap),
  };
}

/** Download each url into `dir`, returning { url -> relativeLocalPath }. Integration-only. */
export async function downloadAssets(urls, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const map = {};
  let i = 0;
  for (const url of urls) {
    const ext = (path.extname(new URL(url).pathname) || ".bin").split("?")[0];
    const name = `asset-${String(i++).padStart(3, "0")}${ext}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(dir, name), buf);
      map[url] = path.join("assets", name);
    } catch { /* skip unreachable asset; eval will flag any missing */ }
  }
  return map;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test assets`
Expected: PASS — both assets tests.

- [ ] **Step 5: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/src/assets.mjs apps/studio/test/assets.test.mjs && \
git commit -m "feat(studio): asset url collection + pure ref rewriting"
```

---

### Task 7: Wire the orchestrator — enriched bundle from real modules

**Files:**
- Modify: `apps/studio/src/capture.mjs`

- [ ] **Step 1: Rewire `capture.mjs` to use the modules**

Keep the existing screenshot passes and `styles.json`. Replace the inline `sections` block (the old flat heuristic, ~lines 106-131 of the current file) with a call to `segmentPage`, and add font + asset resolution before writing `meta.json`. Add these imports at the top (after the existing `playwright`/`fs`/`path` imports):

```js
import { segmentPage } from "./segment.mjs";
import { resolveFonts, fontFileUrls } from "./fonts.mjs";
import { collectAssetUrls, rewriteRefs, downloadAssets } from "./assets.mjs";
```

Replace the old `const sections = await page.evaluate(() => { ... })` block and its `fs.writeFileSync(.../sections.json...)` with:

```js
const sections = await page.evaluate(segmentPage);
fs.writeFileSync(`${OUT}/sections.json`, JSON.stringify(sections, null, 2));

const fontInfo = await page.evaluate(resolveFonts);
const fontUrls = fontFileUrls(fontInfo.faces, url);
```

Then, just before the final `meta.json` write, assemble and rehost assets:

```js
const preBundle = { images: styles.images, fontUrls, faces: fontInfo.faces, loaded: fontInfo.loaded };
const assetMap = await downloadAssets(collectAssetUrls(preBundle), `${OUT}/assets`);
const bundle = rewriteRefs(preBundle, assetMap);
fs.writeFileSync(`${OUT}/assets.json`, JSON.stringify({ ...bundle, assetMap }, null, 2));
```

- [ ] **Step 2: Smoke-run against a fixture served over file://**

Run: `cd ~/pushpress/milo/apps/studio && node src/capture.mjs --url "file://$(pwd)/test/fixtures/nested-wrapper.html" --out /tmp/cap-smoke`
Expected: stdout JSON with `"sections": 3`; `/tmp/cap-smoke/sections.json` has 3 entries; `/tmp/cap-smoke/assets.json` exists.

- [ ] **Step 3: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/src/capture.mjs && \
git commit -m "feat(studio): orchestrate deep capture (segment + fonts + assets)"
```

---

### Task 8: Corpus ground-truth harness (integration)

**Files:**
- Create: `apps/studio/test/corpus.test.mjs`
- Create: `apps/studio/test/corpus.expected.json`

- [ ] **Step 1: Define expected ground-truth facts**

`apps/studio/test/corpus.expected.json` — the invariants Phase 0 must satisfy (calibrated from recon; section counts are `min`/`max` bounds, not exact, to tolerate benign DOM drift):

```json
{
  "beanburito.github.io": { "minSections": 8, "maxSections": 14, "noMonster": true },
  "pushpress-site-modern.webflow.io": { "minSections": 8, "maxSections": 14, "noMonster": true },
  "speakeasyofstrength.com": { "minSections": 5, "maxSections": 14, "noMonster": true, "fontFamilies": ["Bebas Neue"] }
}
```

- [ ] **Step 2: Write the corpus test**

`apps/studio/test/corpus.test.mjs` — re-segments each checked-in corpus URL live and asserts the invariants. Marked slow; network-dependent, so it is the integration gate, not a unit test.

```js
import { test, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { segmentPage } from "../src/segment.mjs";
import { resolveFonts } from "../src/fonts.mjs";

const expected = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "corpus.expected.json")),
);
const urls = {
  "beanburito.github.io": "https://beanburito.github.io/free-intro-session-self-book-in-person/",
  "pushpress-site-modern.webflow.io": "https://pushpress-site-modern.webflow.io/",
  "speakeasyofstrength.com": "https://speakeasyofstrength.com/",
};

let browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

for (const [host, exp] of Object.entries(expected)) {
  test(`corpus: ${host} segments cleanly`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(urls[host], { waitUntil: "load", timeout: 120000 });
    await page.waitForTimeout(2500);
    const total = await page.evaluate(() => document.body.scrollHeight);
    const sections = await page.evaluate(segmentPage);
    const fonts = await page.evaluate(resolveFonts);
    await page.close();

    expect(sections.length).toBeGreaterThanOrEqual(exp.minSections);
    expect(sections.length).toBeLessThanOrEqual(exp.maxSections);
    if (exp.noMonster) {
      expect(Math.max(...sections.map((s) => s.height))).toBeLessThan(total * 0.9);
    }
    for (const fam of exp.fontFamilies ?? []) {
      const all = [...fonts.faces, ...fonts.loaded].map((f) => f.family);
      expect(all.some((f) => f.includes(fam))).toBe(true);
    }
  }, 180000);
}
```

- [ ] **Step 3: Run the corpus gate**

Run: `cd ~/pushpress/milo/apps/studio && pnpm test corpus`
Expected: PASS for all three hosts — in particular Speakeasy now has NO monster block (the original bug) and Bebas Neue is resolved. If a count is out of bounds, tune the segmentation heuristic (Task 4) and re-run; do NOT widen the bounds to force a pass without inspecting the sections.

- [ ] **Step 4: Refresh checked-in corpus captures with the deep pipeline**

Run:
```bash
cd ~/pushpress/milo/apps/studio && \
node src/capture.mjs --url https://beanburito.github.io/free-intro-session-self-book-in-person/ && \
node src/capture.mjs --url https://pushpress-site-modern.webflow.io/ && \
node src/capture.mjs --url https://speakeasyofstrength.com/
```
Expected: each `captures/<host>/` now has `assets/`, `assets.json`, and a deep `sections.json`.

- [ ] **Step 5: Commit**

```bash
cd ~/pushpress/milo && git add apps/studio/test/corpus.test.mjs apps/studio/test/corpus.expected.json apps/studio/captures && \
git commit -m "test(studio): corpus ground-truth gate + deep-capture refresh"
```

---

## Self-Review

**Spec coverage (Phase 0 section):**
- "DOM-based section segmentation" → Tasks 1-4 (+ corpus `noMonster` gate). ✓
- "`@font-face`/loaded-font capture" → Task 5 (+ corpus `fontFamilies` gate). ✓
- "Tokens from computed styles, not CSS vars" → the existing `styles.json` block in `capture.mjs` already reads computed styles (kept in Task 7); token *derivation* is Phase 1's `extract`, out of scope here. ✓ (no Phase 0 gap)
- "per-section DOM subtree + computed styles at both viewports" → segmentation runs; the desktop pass wires it in Task 7. **Note:** the mobile (375) pass currently only screenshots; running `segmentPage` on the mobile viewport is a small addition deferred to Phase 1's align step, which is where per-viewport section data is first consumed. Flagged, not silently dropped.
- "self-host fonts and images; local asset map" → Task 6 (`downloadAssets`, `rewriteRefs`) + Task 7 wiring. ✓
- "golden corpus checked in" → Tasks 8. ✓

**Placeholder scan:** none — every code step contains runnable code and exact commands.

**Type consistency:** `segmentPage`/`resolveFonts` are browser-context (used via `page.evaluate`); `fontFileUrls`/`collectAssetUrls`/`rewriteRefs`/`downloadAssets` are Node-side. Bundle shape (`images`, `fontUrls`, `faces`, `loaded`) is consistent across `assets.mjs`, its test, and `capture.mjs` Task 7. `sections` entry shape defined once in `segment.mjs` and consumed by the corpus test.

**Deferred to later plans (not Phase 0):** per-viewport (mobile) segmentation consumption, interaction-state capture reproduction, and all of extract/IR/render/align/eval/fix.
