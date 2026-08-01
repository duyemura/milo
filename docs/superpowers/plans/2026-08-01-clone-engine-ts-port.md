# Clone Engine → TypeScript, at Parity — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the proven `.mjs` page-clone engine into a typed `@milo/clone-engine` workspace package, provably at parity with the `.mjs` output, behind an engine-select flag — establishing the safety net (golden baseline + parity harness) *before* any behavior can drift.

**Architecture:** New package `packages/clone-engine` holds the engine as TypeScript modules (`capture.ts`, `project.ts`, `orchestrate.ts`, `deploy.ts`) plus a CLI (`cli.ts`). A committed **golden baseline** (the current `.mjs` outputs for the three proven sites) + a **Vitest parity harness** characterization-tests every ported module: projection is a pure function of `capture.json` (byte-identical + 0-px oracle), and capture is exercised deterministically against the *static self-contained clone output* (not a live site). The `.mjs` spike stays runnable and untouched; the CLI `--engine` flag defaults to `mjs` until TS holds parity.

**Tech Stack:** Node 24 (native TS execution — `node file.ts`), TypeScript, Vitest 3, Playwright (already symlinked in the spike), Zod. Package convention: `@milo/*`, `type: module`, raw `./src/*.ts` exports, `vitest run`.

**Scope note:** This is Plan 1 of 2. It ports and parity-locks the *existing proven behavior only* — it adds **no** new features. The labeling pass, `brand.json`, semantic components, `data-*`, and `site.json` (subsystems A+B) are **Plan 2**, built on this typed base. See spec `docs/superpowers/specs/2026-08-01-llm-safe-semantic-representation-design.md`.

**Non-negotiable rule (doctrine):** never regress. The parity harness is the gate; a red harness means the port is wrong, not the golden. Fall back via `--engine=mjs` or `git checkout mjs-engine-proven`.

---

## File structure

```
packages/clone-engine/
  package.json                     # @milo/clone-engine, type:module, vitest, playwright, zod
  src/
    types.ts                       # shared types: CaptureJson, Tree, StyleMap, Head, Interactions
    capture.ts                     # port of page-clone.mjs — render→capture→rehost→capture.json + index.html
    project.ts                     # port of project-page.mjs — capture.json → editable Astro (current behavior)
    orchestrate.ts                 # port of build-site.mjs — crawl→per-page→assemble
    deploy.ts                      # port of deploy.mjs — publish dist to S3/CloudFront (imports @milo/publish)
    cli.ts                         # entrypoint: `node src/cli.ts <capture|project|build|deploy> --engine <mjs|ts> …`
    run-mjs.ts                     # thin child_process shim to invoke the frozen ../../page-clone-spike/*.mjs
  test/
    golden/
      torrance/  speakeasy/  sweatshed/     # each: capture.json, assets/, index.html (clone), recon-*.png
    parity-project.test.ts         # TS project(golden capture.json) === golden index.html  + 0-px oracle
    parity-capture.test.ts         # TS capture(file://golden/index.html) ≈ mjs capture(same)  [structural]
    helpers/pixel.ts               # screenshot + strip-based pixel diff (ported from project-page.mjs pdiff)
```

The engine lives in the workspace; the `.mjs` spike in `page-clone-spike/` is **untouched** and remains the reference oracle.

---

## Task 0: Scaffold `@milo/clone-engine`

**Files:**
- Create: `packages/clone-engine/package.json`
- Create: `packages/clone-engine/src/types.ts`
- Create: `packages/clone-engine/src/index.ts`
- Create: `packages/clone-engine/test/.gitkeep`

- [ ] **Step 1: Create the package manifest**

Create `packages/clone-engine/package.json`:

```json
{
  "name": "@milo/clone-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./capture": "./src/capture.ts",
    "./project": "./src/project.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  },
  "dependencies": {
    "playwright": "^1.48.0",
    "zod": "^3.23.0"
  }
}
```

- [ ] **Step 2: Define shared capture types**

Create `packages/clone-engine/src/types.ts` (mirrors the `capture.json` the `.mjs` already emits — field names copied verbatim from `page-clone.mjs` line 352):

```ts
/** A serialized DOM node: either a text node {t} or an element. */
export type TreeText = { t: string };
export type TreeEl = {
  id: number;
  tag: string;
  attrs: Record<string, string>;
  children: TreeNode[];
};
export type TreeNode = TreeText | TreeEl;

export type StyleMap = Record<string, Record<string, string>>; // id -> prop -> value
export type StylesByWidth = Record<string, StyleMap>;           // "1440"|"768"|"390" -> StyleMap

export interface HeadMeta { key: string; content: string; }
export interface HeadIcon { rel: string; href: string; sizes: string; type: string; }
export interface Head {
  title: string; lang: string;
  metas: HeadMeta[]; icons: HeadIcon[];
  sheetHrefs: string[]; fontFaces: string;
}

export interface ToggleInteraction { toggleId: string; openDelta: StyleMap; prevent: boolean; }
export interface HoverInteraction { parentId: string; delta: StyleMap; }
export interface Interactions { toggles: ToggleInteraction[]; hovers: HoverInteraction[]; }

export interface CaptureJson {
  tree: TreeEl;
  styles: StylesByWidth;
  head: Head;
  fontCss: string;
  interactions: Interactions | null;
  sourceOrigins: string[];
}

export const WIDTHS = [1440, 768, 390] as const;
```

- [ ] **Step 3: Create the barrel export**

Create `packages/clone-engine/src/index.ts` (extended in Task 5 as modules land):

```ts
export * from "./types.ts";
```

- [ ] **Step 4: Install and verify the package parses**

Run: `cd /Users/dan/pushpress/milo && pnpm install`
Expected: installs without error; `@milo/clone-engine` appears in the workspace.

Run: `cd /Users/dan/pushpress/milo && node packages/clone-engine/src/index.ts && echo "clone-engine parses"`
Expected: `clone-engine parses` (modules have no side effects, exit 0).

- [ ] **Step 5: Commit**

```bash
cd /Users/dan/pushpress/milo
git add packages/clone-engine
git commit -m "scaffold(clone-engine): @milo/clone-engine package + capture types"
```

---

## Task 1: Freeze the golden baseline

The golden = the current `.mjs` outputs for one page per proven builder. These are the regression baseline; the TS port must reproduce them. Generated with the **existing, untouched** `.mjs` engine.

**Files:**
- Create (generated): `packages/clone-engine/test/golden/{torrance,speakeasy,sweatshed}/` each containing `capture.json`, `assets/`, `index.html`, `recon-desktop.png`, `recon-mobile.png`
- Create: `packages/clone-engine/test/golden/SOURCES.md`

- [ ] **Step 1: Capture the three sites with the frozen `.mjs` engine**

Run (each ~90–110s; run streaming, NOT piped through `tail`):

```bash
cd /Users/dan/pushpress/milo/page-clone-spike
node page-clone.mjs --url https://www.torrancetraininglab.com/ --out ../packages/clone-engine/test/golden/torrance
node page-clone.mjs --url https://speakeasyofstrength.com/     --out ../packages/clone-engine/test/golden/speakeasy
node page-clone.mjs --url https://sweatshedgym.com/            --out ../packages/clone-engine/test/golden/sweatshed
```

Expected each: `✓ self-contained`, `wrote index.html … + capture.json`, `✓ verified (origins blocked)`.

- [ ] **Step 2: Record provenance**

Create `packages/clone-engine/test/golden/SOURCES.md`:

```markdown
# Golden baseline

Frozen outputs of the proven `.mjs` engine (page-clone-spike/page-clone.mjs @ tag
`mjs-engine-proven`). The TS port must reproduce these. Regenerate ONLY by decision, never to
make a red parity test pass.

- torrance  — https://www.torrancetraininglab.com/  (Webflow)
- speakeasy — https://speakeasyofstrength.com/       (WordPress/Elementor)
- sweatshed — https://sweatshedgym.com/              (Squarespace)

Captured: 2026-08-01.
```

- [ ] **Step 3: Verify each golden is self-contained and complete**

Run:
```bash
cd /Users/dan/pushpress/milo/packages/clone-engine/test/golden
for s in torrance speakeasy sweatshed; do
  node -e "const c=require('node:fs').readFileSync('$s/capture.json','utf8');const j=JSON.parse(c);console.log('$s', 'tree ok:', !!j.tree, 'widths:', Object.keys(j.styles));"
  test -f $s/index.html && echo "$s index.html present" || echo "$s MISSING index.html"
done
```
Expected: each prints a valid tree + `widths: [ '1440', '768', '390' ]` + `index.html present`.

- [ ] **Step 4: Commit the golden**

```bash
cd /Users/dan/pushpress/milo
git add packages/clone-engine/test/golden
git commit -m "test(clone-engine): freeze golden baseline (3 proven sites) for parity"
```

---

## Task 2: Projection parity harness (RED first)

Projection is a **pure function of `capture.json`** → fully deterministic. The harness asserts the TS `project()` reproduces the golden clone `index.html` byte-for-byte AND that the assembled page has 0-px oracle drift. Written RED (no `project.ts` yet).

**Files:**
- Create: `packages/clone-engine/test/helpers/pixel.ts`
- Create: `packages/clone-engine/test/parity-project.test.ts`

- [ ] **Step 1: Port the pixel-diff helper**

Create `packages/clone-engine/test/helpers/pixel.ts` — the strip-based diff from `project-page.mjs:224-241`, as a typed helper:

```ts
import type { Browser } from "playwright";

/** Pixel-diff two PNG buffers in horizontal strips (bounds memory on tall pages). */
export async function pixelDiff(browser: Browser, aPng: Buffer, bPng: Buffer) {
  const dp = await browser.newPage();
  const r = await dp.evaluate(async ([x, y]) => {
    const load = (s: string) => new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = s; });
    const [ia, ib] = await Promise.all([load("data:image/png;base64," + x), load("data:image/png;base64," + y)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const STRIP = 1000, c = document.createElement("canvas"); c.width = w; c.height = Math.min(STRIP, h);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    let d = 0;
    for (let y0 = 0; y0 < h; y0 += STRIP) {
      const sh = Math.min(STRIP, h - y0);
      ctx.clearRect(0, 0, w, sh); ctx.drawImage(ia, 0, y0, w, sh, 0, 0, w, sh); const da = ctx.getImageData(0, 0, w, sh).data;
      ctx.clearRect(0, 0, w, sh); ctx.drawImage(ib, 0, y0, w, sh, 0, 0, w, sh); const db = ctx.getImageData(0, 0, w, sh).data;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i+1] - db[i+1]) > 8 || Math.abs(da[i+2] - db[i+2]) > 8) d++;
    }
    return { d, total: w * h, pct: +(d / (w * h) * 100).toFixed(4), dimMatch: ia.width === ib.width && ia.height === ib.height };
  }, [aPng.toString("base64"), bPng.toString("base64")]);
  await dp.close();
  return r;
}
```

- [ ] **Step 2: Write the RED projection-parity test**

Create `packages/clone-engine/test/parity-project.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../src/project.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["torrance", "speakeasy", "sweatshed"] as const;
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

describe("projection parity vs golden", () => {
  for (const site of SITES) {
    it(`${site}: TS project() reproduces golden index.html byte-for-byte`, async () => {
      const goldenDir = path.join(dir, "golden", site);
      const out = await project({ dir: goldenDir, trim: true }); // returns { indexHtml, ... }
      const golden = fs.readFileSync(path.join(goldenDir, "index.html"), "utf8");
      // Plan-1 port must reproduce current output EXACTLY (no features added yet).
      expect(out.indexHtml).toEqual(golden);
    });
  }
});
```

- [ ] **Step 3: Run — expect RED (module missing)**

Run: `cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run test/parity-project.test.ts`
Expected: FAIL — cannot resolve `../src/project.ts`.

- [ ] **Step 4: Commit the harness**

```bash
cd /Users/dan/pushpress/milo
git add packages/clone-engine/test/helpers packages/clone-engine/test/parity-project.test.ts
git commit -m "test(clone-engine): projection parity harness (red — no project.ts yet)"
```

---

## Task 3: Port projection → `project.ts` (make Task 2 green)

Translate `page-clone-spike/project-page.mjs` into `packages/clone-engine/src/project.ts`, **preserving current behavior exactly** (Plan 1 adds no features). The parity harness is the spec: green = correct port.

**Files:**
- Create: `packages/clone-engine/src/project.ts`

- [ ] **Step 1: Port the module**

Translate `project-page.mjs` verbatim into `project.ts` with these mechanical changes only:
- Wrap the current top-level script body in an exported `export async function project(opts: ProjectOpts): Promise<ProjectResult>`; return the assembled `index.html` string and paths instead of only writing files. Signature:
  ```ts
  import type { CaptureJson } from "./types.ts";
  export interface ProjectOpts { dir: string; out?: string; base?: string; links?: string; trim?: boolean; noDiff?: boolean; }
  export interface ProjectResult { indexHtml: string; outDir: string; astroDir: string; components: number; }
  export async function project(opts: ProjectOpts): Promise<ProjectResult> { /* ported body */ }
  ```
- Read `CAP` from `opts.dir` exactly as today (`capture.json`), keep the `font-display:block` rewrite, trim logic, tokenization, component partition, Astro emit, and (unless `opts.noDiff`) the oracle diff — all unchanged.
- Add explicit `.ts` extensions on local imports; type the `tagDefaults`, `colorTok`, etc. as `Record<...>`; no logic changes.
- Keep writing the same files to `opts.out` (default `out-project-page`) so existing consumers still work; ALSO return `indexHtml` for the harness.
- Preserve exact string output: same escaping, same `.p{id}` classes, same CSS ordering, same token names. **Any divergence from golden is a port bug.**

- [ ] **Step 2: Run the parity harness — iterate to GREEN**

Run: `cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run test/parity-project.test.ts`
Expected: PASS for all three sites (byte-identical to golden).
If a site diverges: diff `out.indexHtml` vs golden, find the translated line that changed behavior, fix the port (never edit the golden).

- [ ] **Step 3: Add the 0-px oracle assertion**

Extend `parity-project.test.ts` with a second assertion per site: render both `out.indexHtml` and golden `index.html` (serving `/assets/` from `golden/<site>/assets`, per `project-page.mjs:218`) at 1440w and 390w, and assert `pixelDiff(...).pct === 0`. Reuse `helpers/pixel.ts`.

Run: `pnpm vitest run test/parity-project.test.ts`
Expected: PASS — byte-identical AND 0-px at both widths.

- [ ] **Step 4: Commit**

```bash
cd /Users/dan/pushpress/milo
git add packages/clone-engine/src/project.ts packages/clone-engine/test/parity-project.test.ts
git commit -m "feat(clone-engine): port projection to TS at parity (byte + 0-px vs golden)"
```

---

## Task 4: Port capture → `capture.ts` (deterministic parity)

Capture depends on a live browser render, so byte-parity against a live site is impossible. Instead exercise it **deterministically against the static self-contained clone output** (`golden/<site>/index.html` is a frozen, fully-rendered, self-contained page): capturing it is deterministic, and it stresses the real capture path (neutralize, tag, grabStyles, rehost, self-containment). Assert structural parity of the two engines' capture on that fixture.

**Files:**
- Create: `packages/clone-engine/src/capture.ts`
- Create: `packages/clone-engine/src/run-mjs.ts`
- Create: `packages/clone-engine/test/parity-capture.test.ts`

- [ ] **Step 1: Port the module**

Translate `page-clone-spike/page-clone.mjs` into `capture.ts` with the same mechanical-only changes: wrap the script body in
```ts
export interface CaptureOpts { url: string; out: string; verify?: boolean; }
export async function capture(opts: CaptureOpts): Promise<{ capture: CaptureJson; outDir: string }>;
```
Keep every function byte-faithful (`neutralizeAndTag`, `grabStyles`, `grabHead`, `sniffExt`, `fetchAsset`, rehost loop, self-containment assertion, interactions capture, emit). Add types from `./types.ts`. **No logic changes** — the assertion still `process.exit(1)`s→ instead `throw` a typed error so callers can catch (behavior for the CLI is identical: non-zero exit).

- [ ] **Step 2: Add the `.mjs` shim**

Create `run-mjs.ts` — a typed `child_process` wrapper that runs the frozen `.mjs` for A/B comparison:
```ts
import { execFileSync } from "node:child_process";
import path from "node:path";
const SPIKE = path.resolve(import.meta.dirname, "../../../page-clone-spike");
export function mjsCapture(url: string, out: string) {
  execFileSync("node", ["page-clone.mjs", "--url", url, "--out", out, "--no-verify"], { cwd: SPIKE, stdio: "inherit" });
}
```

- [ ] **Step 3: Write the deterministic capture-parity test**

Create `parity-capture.test.ts`: for each site, serve `golden/<site>/` over a local static server, run TS `capture()` and `mjsCapture()` against `http://localhost:PORT/index.html`, and assert **structural parity**: same element count (`Object.keys(styles['1440']).length`), identical tree tag-sequence, identical set of style-prop keys per id. (Not byte-identical asset filenames — rehost order differs; compare structure + style values.)

```ts
import { describe, it, expect } from "vitest";
// serve golden/<site> statically, capture with both engines against the static page, compare:
// - tree shape (tags in depth-first order)
// - styles["1440"] key count and per-id prop values
// (assets: compare count + that every ref resolves, not the aN.* names)
```

Run: `cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run test/parity-capture.test.ts`
Expected: PASS — TS and `.mjs` capture the same static page to structurally identical trees + styles.

- [ ] **Step 4: Commit**

```bash
cd /Users/dan/pushpress/milo
git add packages/clone-engine/src/capture.ts packages/clone-engine/src/run-mjs.ts packages/clone-engine/test/parity-capture.test.ts
git commit -m "feat(clone-engine): port capture to TS; deterministic parity vs .mjs on static clone"
```

---

## Task 5: Port orchestrator + deploy, add engine-select CLI

**Files:**
- Create: `packages/clone-engine/src/orchestrate.ts`
- Create: `packages/clone-engine/src/deploy.ts`
- Create: `packages/clone-engine/src/cli.ts`
- Modify: `packages/clone-engine/src/index.ts` (extend the barrel)

- [ ] **Step 1: Port `orchestrate.ts`**

Translate `build-site.mjs` into `orchestrate.ts` as `export async function buildSite(opts: { pages: PageSpec[] }): Promise<{ ok: PageSpec[] }>`, calling the TS `capture`/`project` directly (not child_process). Keep the crawl/link-map/assemble logic identical.

- [ ] **Step 2: Port `deploy.ts`**

Translate `deploy.mjs` into `deploy.ts` — same `publishStaging` import from `@milo/publish` (change the relative `../packages/publish/src/index.ts` to the package name `@milo/publish`), same config, same args.

- [ ] **Step 3: CLI with `--engine` fallback**

Create `cli.ts`: subcommands `capture|project|build|deploy`; global `--engine <mjs|ts>` (default `mjs`). `ts` calls the ported functions; `mjs` shells out to the frozen spike via `run-mjs.ts`. This makes fallback a one-flag change.

```ts
// node src/cli.ts capture --url <u> --out <d> --engine ts
// node src/cli.ts capture --url <u> --out <d> --engine mjs   (default; shells to page-clone.mjs)
```

- [ ] **Step 4: Extend the barrel export**

Extend `packages/clone-engine/src/index.ts` (created in Task 0) to add the ported functions:
```ts
export * from "./types.ts";
export { capture } from "./capture.ts";
export { project } from "./project.ts";
export { buildSite } from "./orchestrate.ts";
```

- [ ] **Step 5: Smoke-test the CLI both ways**

Run:
```bash
cd /Users/dan/pushpress/milo/packages/clone-engine
node src/cli.ts project --dir test/golden/speakeasy --out /tmp/pc-ts --engine ts && echo "TS engine ok"
node src/cli.ts project --dir test/golden/speakeasy --out /tmp/pc-mjs --engine mjs && echo "mjs engine ok"
```
Expected: both print `… ok`; `/tmp/pc-ts/index.html` and `/tmp/pc-mjs/index.html` are byte-identical (`diff -q /tmp/pc-ts/index.html /tmp/pc-mjs/index.html` → no output).

- [ ] **Step 6: Commit**

```bash
cd /Users/dan/pushpress/milo
git add packages/clone-engine/src/orchestrate.ts packages/clone-engine/src/deploy.ts packages/clone-engine/src/cli.ts packages/clone-engine/src/index.ts
git commit -m "feat(clone-engine): port orchestrator + deploy; engine-select CLI (mjs default)"
```

---

## Task 6: Full regression sweep + flip default to TS

**Files:**
- Modify: `packages/clone-engine/src/cli.ts` (default `--engine` → `ts`)

- [ ] **Step 1: Run the whole package test suite**

Run: `cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run`
Expected: PASS — projection parity (byte + 0-px, 3 sites) and capture parity (3 sites) all green.

- [ ] **Step 2: Run the workspace suite (no collateral breakage)**

Run: `cd /Users/dan/pushpress/milo && pnpm -r test`
Expected: all packages green (existing ~211 tests + new clone-engine tests).

- [ ] **Step 3: Flip the CLI default to `ts`**

Modify `cli.ts`: default `--engine` from `mjs` → `ts`. `mjs` remains available for fallback.

- [ ] **Step 4: Re-run parity after the flip**

Run: `cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run`
Expected: PASS (unchanged — the flip only changes the default).

- [ ] **Step 5: Commit + tag the TS-at-parity milestone**

```bash
cd /Users/dan/pushpress/milo
git add packages/clone-engine/src/cli.ts
git commit -m "feat(clone-engine): flip CLI default to TS engine (parity held on 3 sites)"
git tag -a ts-engine-at-parity -m "TS clone engine reproduces .mjs at parity (byte + 0-px) on 3 proven sites."
```

---

## Done when

- `@milo/clone-engine` exists as a typed workspace package; `pnpm -r test` is green.
- Projection parity: TS `project()` is **byte-identical + 0-px** vs golden on Torrance/Speakeasy/Sweatshed.
- Capture parity: TS `capture()` is structurally identical to `.mjs` on the static clone fixtures.
- CLI defaults to the TS engine with a working `--engine=mjs` fallback; `.mjs` spike untouched.
- Tags `mjs-engine-proven` (go-back) and `ts-engine-at-parity` (milestone) both exist.

**Then Plan 2** builds the labeling pass, `brand.json`, semantic components, `data-*`, and `site.json` on this typed base — every step gated by the same parity harness (byte parity relaxes to the pixel oracle once features intentionally change HTML).
