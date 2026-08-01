# @milo/clone-engine

Turns a live website into a faithful, self-contained, editable multi-page [Astro](https://astro.build) clone. It renders the source in a real browser, transcribes the DOM plus computed styles at desktop/tablet/mobile widths, rehosts every asset locally, and emits responsive self-contained HTML — then projects that into lean, per-section Astro components proven lossless against the capture by a pixel oracle. Layout is **copied, not generated**: no LLM, no documents, no self-healing loop. See [DOCTRINE.md](./DOCTRINE.md) for the why.

## Library API

```ts
import { capture, project, buildSite } from "@milo/clone-engine";
import type { CaptureOpts, ProjectOpts, ProjectResult, PageSpec, BuildSiteOpts, BuildSiteResult } from "@milo/clone-engine";
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

### `project(opts: ProjectOpts): Promise<ProjectResult>`

Reads a capture's `capture.json` and projects it into lean editable components + a real Astro project.

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
node src/cli.ts <capture|project|build|deploy> [--engine ts|mjs] <flags>
```

`--engine` defaults to `ts` (the TypeScript engine, at parity with the frozen spike). `--engine mjs` shells out to the frozen `.mjs` reference scripts in `page-clone-spike/`.

| Subcommand | Flags |
|---|---|
| `capture` | `--url <url> --out <dir>` |
| `project` | `--dir <dir> --out <outDir> [--base <base>] [--links <file>]` |
| `build`   | (no flags; whole-site orchestrator, runs from cwd — defaults to the built-in Speakeasy page list) |
| `deploy`  | `--dist <distDir> --slug <slug>` — `--engine ts` only; writes to S3, needs AWS creds |

`deploy` is intentionally CLI-only (it needs env + AWS creds) and is **not** exported from the library.

## What an OUT dir contains

```
<out>/
├── index.html      # self-contained page (inlined CSS, local asset refs)
├── assets/         # every rehosted image + font (aN.*, fN.*)
└── capture.json    # structured capture consumed by project()
```

`project()` additionally emits `components/`, `tokens.css`, and an `astro/` project.

## More

Philosophy, fidelity guarantees, and the parity-test contract live in [DOCTRINE.md](./DOCTRINE.md).
