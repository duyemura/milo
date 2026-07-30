# Plan — Milo v2 Generate: docs → site reprojection engine

**Date:** 2026-07-29  
**Builds on:** `docs/HANDOFF-2026-07-29.md`, `docs/specs/2026-07-19-milo-v2-rethink-design.md`  
**Goal:** Extract the LLM synthesis step out of `packages/intake` into a reusable `@milo/generate` package, so `gym.json` becomes a re-runnable projection of the docs. Intake keeps working as-is by delegating to generate; a new `milo generate` CLI can regenerate `gym.json` from an existing crawl/doc bundle.

## Why this approach (framing #3)

We keep the proven intake path untouched at the user-facing level, but we make the *engine* that turns crawl/docs into `GymDocuments` a shared, testable package. That gives us:

- `docs = truth, site = projection` — a doc change can be re-run through `milo generate` to get a new `gym.json` without re-crawling.
- AI assistant / reskin later — they call the same `generateSite` function, just with edited docs.
- No intake regression — intake still writes `gym.json` in one command; it just calls the new package.

This is the lowest-risk path that still fixes the architectural blur from the handoff.

## Scope

In scope for this milestone:
1. Move `llmJson` into `@milo/llm` (both intake and generate need it).
2. Move raw crawl artifact schemas (`PageDocument`, `IdentityCrawl`, `BrandCrawl`, `PagesJson`, `LinkMap`) into `@milo/schema` so generate can import them without depending on intake.
3. Create `packages/generate` with `generateSite(docs + crawl) → GymDocuments`.
4. Refactor `packages/intake` to call `@milo/generate` for `gym.json` and keep context/business/integrations as intake outputs.
5. Add `milo generate --docs <dir> --out <dir>` to the CLI.
6. Tests + README update.

Out of scope:
- Thin-input generator (`milo generate --from-scratch`) — a separate, future build.
- Refactoring intake to *only* emit knowledge docs (#1) — we leave intake’s one-shot `gym.json` behavior intact.
- Intake quality gaps (fonts, asset download, crawl caps) — parked per handoff.

## Detailed tasks

### Task 1 — Move `llmJson` to `@milo/llm`

**Files:**
- Create `packages/llm/src/llm-json.ts` (port from `packages/intake/src/llm-json.ts`).
- Update `packages/llm/src/index.ts` to export `llmJson`, `ChatFn`, and `LlmJsonOptions`.
- Create `packages/llm/test/llm-json.test.ts` — fake chat, test JSON retry on bad JSON and Zod retry on validation errors.
- Delete `packages/intake/src/llm-json.ts`.
- Update `packages/intake/src/classify.ts` and any other intake files to import `llmJson` / `ChatFn` from `@milo/llm`.

**Verification:** `pnpm --filter @milo/llm test` passes; intake imports compile.

### Task 2 — Move crawl artifact schemas to `@milo/schema`

**Files:**
- Create `packages/schema/src/crawl.ts` containing `PagesJson`, `PageDocument`, `IdentityCrawl`, `BrandCrawl`, `LinkMap` (ported from `packages/intake/src/schemas.ts`).
- Export them from `packages/schema/src/index.ts`.
- Update `packages/intake/src/{discover,crawl,crawl-graph,places,classify,intake,synthesize,index}.ts` to import the moved schemas from `@milo/schema` instead of `./schemas.ts`.
- Keep intake-specific output docs (`ContextDoc`, `BusinessDoc`, `IntegrationsDoc`) in `packages/intake/src/schemas.ts`; intake’s `index.ts` continues to re-export them.

**Verification:** `pnpm --filter @milo/intake test` still passes; no type errors.

### Task 3 — Create `packages/generate`

**Files:**
- `packages/generate/package.json` — workspace package, depends on `@milo/schema`, `@milo/llm`, `zod`, `vitest`.
- `packages/generate/src/index.ts` — export `generateSite`, `GenerateSiteInput`, `GenerateSiteResult`.
- `packages/generate/src/generate.ts`:
  - `GenerateSiteInput`: `chat`, `model`, `identity: IdentityCrawl`, `brand: BrandCrawl`, `pages: PageDocument[]`, `budgets: Map<string, "full" | "truncated">`, optional `context`/`business` (`Record<string, unknown>`), optional `charCeiling`.
  - `budgetPages()` — moved from intake’s synthesize, keeps the same progressive-truncation logic.
  - `pageDigest()` — compact text digest of budgeted pages.
  - `GymDocumentsStrict` — super-refine `GymDocuments` by validating each section’s content against `Section.safeParse` (same as current intake logic).
  - `sectionShapeGuide()` — generated from the schema union, fed to the LLM.
  - `generateSite()` — build system + user prompts, call `llmJson(GymDocumentsStrict, ...)` with retries, return `{ gym }`.
  - The prompt should include: identity, brand, available section vocabulary, section shape guide, optional context/business JSON, and the page digest.
- `packages/generate/test/fakes.ts` — `fakeChat` helper (small, self-contained).
- `packages/generate/test/generate.test.ts`:
  - Fake chat returns a valid `GymDocuments` JSON object.
  - Assert `generateSite` returns a parsed `GymDocuments`.
  - Assert the prompt includes the section shape guide and the gym name from identity.
  - Assert malformed LLM output triggers retry/throw.

**Verification:** `pnpm --filter @milo/generate test` passes.

### Task 4 — Refactor intake to use `@milo/generate`

**Files:**
- Delete `packages/intake/src/synthesize.ts`.
- Create `packages/intake/src/context.ts` with `analyzeContext(input)`:
  - Takes `chat`, `model`, `pages`, `budgets`, `identity`, `brand`.
  - Builds a truncated page digest.
  - Calls `llmJson(ContextDoc, ...)` with the same explicit-shape system prompt currently in `synthesize.ts`.
- Update `packages/intake/src/intake.ts`:
  - After crawl/classify/brand extraction, run `classifyBusiness` and `buildIntegrations`.
  - Run `analyzeContext`.
  - Run `generateSite` from `@milo/generate`, passing `context` and `business`.
  - Write `context.json`, `business.json`, `integrations.json`, `gym.json` as before.
  - Remove the `GymDocuments.parse(gym)` call (generate already validates with `GymDocumentsStrict`), or keep it as a cheap safety check.
- Update `packages/intake/package.json` to add `@milo/generate: workspace:*` dependency.
- Update `packages/intake/test/intake.test.ts` fake chat response order to match the new call sequence: 3 page classifications → context → business → gym.

**Verification:** `pnpm --filter @milo/intake test` passes.

### Task 5 — Add `milo generate` CLI command

**Files:**
- Update `apps/cli/src/milo.ts`:
  - Add `generate` command.
  - Flags: `--docs <dir>` (default `./intake-output`), `--out <dir>` (default to docs dir), optional `--model`.
  - Read `crawl/identity.json`, `crawl/brand.json`, `crawl/pages.json`, and all `crawl/pages/*.json`.
  - Read optional `context.json` and `business.json` from the docs dir.
  - Reconstruct `PageDocument[]` and budgets map.
  - Set up `chat` with `@milo/llm` chatCompletion (same env/config pattern as `milo intake`).
  - Call `generateSite`.
  - Write `gym.json` to the output dir.
- Update `apps/cli/package.json` to add `@milo/generate: workspace:*` dependency.
- Update CLI header comment to document `milo generate`.

**Verification:** Add a CLI integration-style test or run it manually against the existing `intake-output` fixture from a prior run (no new crawl needed).

### Task 6 — Full test run and README update

- Run `pnpm test` at the root — expected all green.
- Update `README.md`:
  - Add `packages/generate` to the layout table.
  - Document `pnpm milo generate --docs <dir> --out <dir>`.
  - Clarify that `milo intake` produces docs + `gym.json`, while `milo generate` reprojects docs → `gym.json`.
- Update `docs/HANDOFF-2026-07-29.md` or create a new handoff noting the open decision is resolved and the next build is done.

## Risk + mitigation

| Risk | Mitigation |
|---|---|
| Moving `llm-json` breaks intake imports | Mechanical import rewrite + intake tests |
| Moving crawl schemas breaks intake type graph | Update all local `./schemas.ts` imports, run intake tests |
| New prompt/ordering changes real-gym output quality | Run `milo intake --skip-crawl` against saved Buckhead crawl and diff `gym.json` |
| CLI `generate` cannot reconstruct budgets/pages | Reuse the same `PagesJson` + `pages/*.json` layout intake writes |

## Success criteria

1. `pnpm test` at root passes with no new failures.
2. `milo generate --docs <intake-output-dir>` produces a valid `gym.json` without network crawl.
3. `milo intake --url <gym>` still produces all four output files end-to-end.
4. The generate package has no dependency on `@milo/intake` — only on `@milo/schema` and `@milo/llm`.
