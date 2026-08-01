# @milo/clone-engine

Turns a live website into a faithful, self-contained, editable multi-page [Astro](https://astro.build) clone. It renders the source in a real browser, transcribes the DOM plus computed styles at desktop/tablet/mobile widths, rehosts every asset locally, and emits responsive self-contained HTML — then projects that into lean, per-section Astro components proven lossless against the capture by a pixel oracle. Layout is **copied, not generated**: no LLM, no documents, no self-healing loop. See [DOCTRINE.md](./DOCTRINE.md) for the why.

On top of the faithful clone sits a **semantic layer** (Plan 2 / A+B): a `label` stage annotates the capture, and `project()` consumes those labels to stamp `data-*` addressability, name components semantically, cascade a global `brand.json`, and emit a `site.json` manifest. Everything the semantic layer adds is metadata — it never changes a rendered pixel, so the un-edited projection still diffs **0-px** against the clone (proven both on the assembled `index.html` and on the real `astro build` output).

## Library API

```ts
import { capture, label, project, buildSite, heuristicLabels, buildManifest } from "@milo/clone-engine";
import type {
  CaptureOpts, ProjectOpts, ProjectResult, PageSpec, BuildSiteOpts, BuildSiteResult,
  Labels, SiteManifest, ManifestPage, ManifestSection, ManifestElement, ManifestAsset, ManifestCopyEntry,
  BrandDoc, SectionLabel, ElementLabel, AssetLabel,
} from "@milo/clone-engine";
```

### `capture(opts: CaptureOpts): Promise<{ capture: CaptureJson; outDir: string }>`

Renders a URL and writes a self-contained clone to `out`.

```ts
type CaptureOpts = {
  url: string;      // page to clone
  out: string;      // output directory (created/cleaned)
  verify?: boolean; // re-render with source origins BLOCKED to prove self-containment (default: true)
};
```

Writes to `out`: `index.html`, `assets/` (every rehosted image/font), `capture.json` (the structured capture the projector consumes), plus `source-*.png` and — when `verify` is on — `recon-*.png` screenshots. Throws if any rehosted asset is missing on disk (never ships a broken clone).

### `label(opts: { dir: string; out?: string; llm?: boolean }): Promise<Labels>`

Reads `<dir>/capture.json`, computes semantic **labels**, and writes `labels.json` (to `out` or `dir`). Labels assign a role to each section (from a fixed vocabulary — `hero`, `pricing`, `testimonials`, …), map brand colors/fonts to slots (`primary`, `accent`, `surface`, `text`, `muted` / `display`, `body`), and tag key elements (`headline`, `primary-cta`, `logo`) and assets (`logo`, `hero-image`).

Two paths, same schema:

- **Heuristic** (default, deterministic) — keyword + usage-stat analysis. Same capture → byte-identical labels. No network, no LLM.
- **LLM** (enhancement, never a hard dependency) — when `LLM_PROVIDER` + `DEFAULT_LLM_MODEL` are set and `llm !== false`, an LLM annotates a compact digest of the capture. Every id/color/font/file it emits is post-validated against the real capture (hallucinations dropped or snapped). **Any** LLM failure falls back to the heuristic. `llm: false` forces the heuristic.

Labels are **metadata only** — they change component names and `data-*` attributes, never the rendered pixels. `project()` reads `labels.json` if present, otherwise computes the heuristic labels itself, so labeling is optional to run separately.

### `project(opts: ProjectOpts): Promise<ProjectResult>`

Reads a capture's `capture.json` (and `labels.json` if present) and projects it into lean editable components + a real Astro project, plus the semantic-layer outputs (`brand.json`, `site.json`, `data-*` stamping).

```ts
type ProjectOpts = {
  dir: string;      // a capture output dir (must contain capture.json + assets/)
  out?: string;     // output dir (default: "out-project-page")
  base?: string;    // Astro base path for sub-pages (e.g. "/about")
  links?: string;   // path to a JSON link map for internal-nav rewriting
  trim?: boolean;   // drop CSS props equal to UA/inherited defaults (default: true)
  noDiff?: boolean; // skip the pixel-diff oracle (default: false)
};
type ProjectResult = {
  indexHtml: string; // assembled self-contained HTML (the parity gate compares this)
  outDir: string;
  astroDir: string;  // emitted Astro project (src/pages, src/components, public/assets)
  components: number;
};
```

### `buildSite(opts: BuildSiteOpts): Promise<BuildSiteResult>`

Whole-site orchestrator: for each page, capture (cached if `capture.json` exists) → project → `astro build`, then assemble a combined `full-site/`.

```ts
type PageSpec = { route: string; dir: string };        // dir = per-page capture output dir
type BuildSiteOpts = { origin: string; pages: PageSpec[]; cwd?: string };
type BuildSiteResult = { ok: PageSpec[]; failed: PageSpec[] };
```

Pages that fail are skipped and reported in `failed` (build continues). If **every** page fails, `buildSite` throws instead of emitting an empty `full-site/`.

## CLI

```
node src/cli.ts <capture|label|project|build|deploy> [--engine ts|mjs] <flags>
```

`--engine` defaults to `ts` (the TypeScript engine, at parity with the frozen spike). `--engine mjs` shells out to the frozen `.mjs` reference scripts in `page-clone-spike/`.

| Subcommand | Flags |
|---|---|
| `capture` | `--url <url> --out <dir>` |
| `label`   | `--dir <dir> [--out <dir>] [--no-llm]` — writes `labels.json`, prints a role/brand summary |
| `project` | `--dir <dir> --out <outDir> [--base <base>] [--links <file>]` |
| `build`   | (no flags; whole-site orchestrator, runs from cwd — defaults to the built-in Speakeasy page list) |
| `deploy`  | `--dist <distDir> --slug <slug>` — `--engine ts` only; writes to S3, needs AWS creds |

`deploy` is intentionally CLI-only (it needs env + AWS creds) and is **not** exported from the library.

## What an OUT dir contains

A **capture** dir (from `capture()`):

```
<out>/
├── index.html      # self-contained page (inlined CSS, local asset refs)
├── assets/         # every rehosted image + font (aN.*, fN.*)
├── capture.json    # structured capture consumed by project()
└── labels.json     # (if label() was run here) semantic labels consumed by project()
```

A **projection** dir (from `project()`) additionally contains:

```
<out>/
├── index.html      # assembled self-contained page (the 0-px parity gate)
├── components/      # one lean .astro per section, data-* stamped
├── tokens.css       # :root cascade — brand slots + per-literal color/font tokens
├── brand.json       # editable global brand document (colors/fonts/space/radius)
├── site.json        # the agent-addressable site manifest (see below)
└── astro/           # a real Astro project (src/pages, src/components, public/assets)
```

## The semantic layer (Plan 2 / A+B)

The projection is faithful **and** addressable. Three artifacts + a `data-*` contract make every part of the page reachable by name, so a downstream subsystem (or an LLM agent) can edit it without touching layout.

### `labels.json`

The semantic annotation of the capture (from `label()`). Sections → roles, brand colors/fonts → slots, key elements → roles, assets → aliases. Deterministic by default; LLM-enhanced when configured. Metadata only.

### `brand.json`

The editable global brand document (mirrors `@milo/schema`'s `BrandTokens`): `colors` (`primary`/`accent`/`surface`/`text`/`muted` as `#rrggbb`), `fonts` (`display`/`body`), plus `space`/`radius`. The projector rewrites each captured color literal that maps to a brand slot into a canonical `var(--color-<slot>)` (opacity variants → `--color-<slot>-<NN>`), so editing one slot in the emitted `:root` recolors every reference. **Byte-preserving:** a canonical var resolves to the exact captured literal, so the rewrite is 0-px.

### `site.json` — the interface downstream subsystems consume

The machine-readable site map. **This is the contract that subsystems C/D/E/F build on** — edit-ops, page types/goals, section generation, and measurement all address the site through `site.json` rather than re-parsing HTML.

```jsonc
{
  "brand": "brand.json",
  "pages": [{
    "route": "/",
    "component": "index.astro",
    "sections": [{ "name": "HeroSection", "role": "hero", "file": "HeroSection.astro" }],
    "elements": [{ "role": "primary-cta", "id": "p42", "selector": "[data-role=primary-cta]" }],
    "assets":   [{ "alias": "logo", "file": "assets/a1.png" }],
    "copy":     [{ "key": "HeroSection.0", "component": "HeroSection", "index": 0 }]
  }]
}
```

Every handle resolves (verified by test on all 3 goldens): section → component file, role → element (class + `data-role`), alias → on-disk asset, copy-key → a component's editable `content[]` slot.

### The `data-*` contract

The projection stamps these render-neutral attributes so the site is addressable from the DOM alone:

| Attribute | On | Meaning |
|---|---|---|
| `data-section="<role>"` | section root | the section's semantic role (`hero`, `pricing`, …) |
| `data-component="<Name>"` | section root | the owning `.astro` component (e.g. `HeroSection`) |
| `data-role="<role>"` | element | a labeled element (`headline`, `primary-cta`, `logo`, …) |
| `data-asset="<alias>"` | element referencing an asset | the asset alias (`logo`, `hero-image`) |
| `data-copy="<key> …"` | element with direct text | space-separated copy keys → `content[]` slots for editable text |

To edit copy: find the element by its `data-copy` key (or by `data-role` + `data-section` context), look the key up in `site.json`'s `copy[]` to get `{ component, index }`, then edit `content[index]` in that component's `.astro` file.

## Fidelity gates

- **Assembled oracle** (`parity-project.test.ts`) — the assembled `index.html` diffs 0-px vs the golden clone @1440+@390 on all 3 sites.
- **Shipped-artifact oracle** (`astro-build.test.ts` / `scripts/astro-oracle.mjs`) — the real `astro build` output (components + `data-copy`) diffs 0-px vs the clone too, so the editable artifact — not just the flattened reference — is proven faithful. Needs an astro `node_modules`; the test skips when none is available and the script runs the same build+diff on demand.

## More

Philosophy, fidelity guarantees, and the parity-test contract live in [DOCTRINE.md](./DOCTRINE.md).
