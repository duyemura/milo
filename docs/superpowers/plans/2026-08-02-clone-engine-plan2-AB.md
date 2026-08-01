# Plan 2 — A+B: LLM-Safe Semantic Representation + Global Brand Document

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking. Every task's hard gate is the existing 9 parity tests staying green (0-px oracle) PLUS the task's new assertion — the fidelity oracle is the executable spec, exactly as in Plan 1.

**Goal:** Turn the faithful-but-opaque clone into an **LLM-editable semantic substrate** — semantic components + `data-*` addressability + a global `brand.json` cascade + a `site.json` manifest — WITHOUT costing any fidelity (the un-edited projection must still diff 0-px against the clone).

**Architecture:** Capture is unchanged. A new `label` stage annotates the capture (`labels.json`); `project.ts` is extended to *consume* labels — stamping `data-*`, naming components semantically, rewriting canonical brand literals to `var()`, and emitting `brand.json` + `site.json`. The labeler has a deterministic **heuristic** path (built first, testable) and an **LLM** path (added last, as an enhancement — never a hard dependency). Everything is value-preserving/metadata, so the 0-px oracle holds.

**Tech stack:** Node 24 native TS, the existing `@milo/clone-engine` package, `@milo/llm` (`llmJson` + Zod), Vitest, Playwright. Design spec (authoritative): `docs/superpowers/specs/2026-08-01-llm-safe-semantic-representation-design.md`. Doctrine: `packages/clone-engine/DOCTRINE.md`.

**Non-negotiable invariant (never regress):** after EVERY task, `cd packages/clone-engine && pnpm vitest run` is GREEN and `tsc --noEmit` clean. The real fidelity gate is the **pixel oracle: assembled-vs-clone == 0-px @1440+@390 on all 3 sites** — it must hold at every step. The projection's HTML bytes DO change (new `data-*`/tokens/names are the whole point) — so the **byte-vs-`.mjs` assertion is RETIRED in Task 1** (the port's job is done; tag `ts-engine-at-parity`). From Task 1 on, the gate is: pixel-oracle 0-px + the task's new semantic/brand/manifest assertions + `tsc` clean. A pixel drift ≠ 0 means the change wasn't value-preserving → fix it, never weaken the oracle.

**Scope:** A+B only — representation + brand doc + manifest. NOT edit-ops (C), page types/goals (D), section generation (E), measurement (F). Per-site; no batch anything.

---

## Canonical vocabularies (fixed up front, used by all tasks)

- **Section roles** (`data-section`, `labels.sections[].role`) — A-owned taxonomy, seeded from `@milo/schema`'s 16 types: `hero faq program-cards coach-grid testimonials pricing cta-band feature-grid location-map schedule stats-band logo-strip media-block content-block contact-form lead-form` + `unknown`.
- **Brand slots** (`brand.json`, `labels.brand`) — `BrandTokens` shape (`packages/schema/src/brand-tokens.ts` is compatible prior art): colors `primary accent surface text muted`, fonts `display body`, plus `space`/`radius`. Canonical CSS var names `--color-<slot>`, `--font-<slot>`.
- **Element roles** (`data-role`, `labels.elements[].role`) — open set, common: `primary-cta secondary-cta logo headline nav-link social-link`.
- **Asset aliases** (`data-asset`, `labels.assets[].alias`) — e.g. `logo hero-bg`.

---

## File structure

```
packages/clone-engine/src/
  labels.ts        NEW — LabelSchema (Zod) + heuristic labeler + LLM labeler + fallback; capture.json → labels.json
  brand.ts         NEW — labels.brand → brand.json (BrandTokens shape); canonical-slot literal→var() map; derived variant tokens; :root flatten
  manifest.ts      NEW — capture + labels + regions → site.json (pages→sections→elements→assets→brand ref)
  project.ts       MODIFY — consume labels.json: data-* stamping, semantic component names, brand var() rewrite, data-copy keys, emit brand.json + site.json
  types.ts         MODIFY — add Labels, SectionLabel, BrandDoc, SiteManifest types + SECTION_ROLES/BRAND_SLOTS consts
  index.ts         MODIFY — export label(), the new types
test/
  labels.test.ts       NEW — heuristic labeler determinism + schema validation on golden captures; LLM labeler mocked (fakeChat) + fallback
  brand.test.ts        NEW — brand.json shape, canonical-slot mapping, variant derivation, :root flatten
  semantic.test.ts     NEW — data-* present + correct on projected output; manifest resolves (role→id, alias→file); copy-key round-trip
  parity-project.test.ts   MODIFY — the 6 existing tests must still pass; the projection now runs the full A+B path (labels present)
```

**Sequencing rationale:** heuristic labeler first (deterministic → everything downstream is testable without the LLM) → data-* (render-neutral) → component names → brand cascade (the coupling-risk step) → manifest (pure metadata) → copy keys → LLM labeler (enhancement, mocked in tests) → integration sweep. Each step is independently oracle-gated.

---

## Task 0: Labels schema + types + heuristic labeler

**Files:** Create `src/labels.ts`; modify `src/types.ts`; Create `test/labels.test.ts`.

- [ ] **Step 1 — types + consts.** In `types.ts` add `export const SECTION_ROLES = [...] as const` (the 16 + `unknown`), `export const BRAND_SLOTS = { colors:[...], fonts:[...] } as const`, and types: `SectionLabel {id:number; name:string; role:string}`, `ElementLabel {id:number; role:string}`, `AssetLabel {file:string; alias:string}`, `BrandSlotColor {slot:string; canon:string}`, `BrandSlotFont {slot:string; family:string}`, `Labels {site:{name:string;purpose:string}; brand:{colors:BrandSlotColor[];fonts:BrandSlotFont[]}; sections:SectionLabel[]; elements:ElementLabel[]; assets:AssetLabel[]}`.

- [ ] **Step 2 — `LabelSchema` (Zod).** In `labels.ts`, a Zod schema matching `Labels` (roles constrained to the vocab where fixed; `unknown` allowed). This is what the LLM path validates against later.

- [ ] **Step 3 — heuristic labeler (deterministic).** `heuristicLabels(cap: CaptureJson): Labels`:
  - brand colors: from `cap.styles["1440"]` compute usage stats per canonicalized color (reuse project's `canon`); most-used saturated color on interactive elements (`a`/`button`) → `primary`, page bg → `surface`, dominant text color → `text`, a secondary saturated → `accent`, a mid-gray → `muted`. fonts: heaviest/largest-text font-family → `display`, dominant body font → `body`.
  - sections: top-level children of the main content root (mirror project.ts's region partition — `findTag('main')` then descend single-child) → `role: nearest-keyword-match against SECTION_ROLES from the section's heading/copy, else 'unknown'`; `name`: derived from the heading (mirror project's region naming).
  - elements: `logo` = first `<img>` in `<header>`; `primary-cta` = the most prominent `<a>`/`button` (by size/brand-color bg); `headline` = the `<h1>`.
  - assets: `logo` alias for the header img's file; else best-effort.
  - MUST be pure + deterministic (no Date/random). Same capture → same labels.

- [ ] **Step 4 — `export async function label(opts:{dir:string; out?:string; llm?:boolean}): Promise<Labels>`.** Reads `capture.json` from `dir`, computes labels (heuristic for now; LLM added in Task 6), writes `labels.json` to `dir` (so `project` can read it), returns them.

- [ ] **Step 5 — test.** `labels.test.ts`: for each golden site, `heuristicLabels(capture)` (a) validates against `LabelSchema`, (b) is deterministic (two calls deep-equal), (c) sanity: brand has a `primary` + `surface`, sections non-empty, at least a `headline` element. Run `pnpm vitest run test/labels.test.ts` → green.

- [ ] **Step 6 — commit** (`feat(clone-engine): labels schema + deterministic heuristic labeler`). Gate: full `pnpm vitest run` still 9+new green; `tsc` clean.

---

## Task 1: `data-*` stamping in projection (render-neutral)

**Files:** Modify `src/project.ts`; Create `test/semantic.test.ts`.

- [ ] **Step 1 — load labels.** In `project()`, after reading `CAP`, read `labels.json` from `DIR` if present (else compute via `heuristicLabels(CAP)` so projection always has labels). Build lookup maps: `roleOfEl[id]`, `sectionRoleOf[id]` (region node id → role), `aliasOfEl[id]` (element carrying an asset → alias), `copyKeyOf` (see Task 5 — stub for now).

- [ ] **Step 2 — stamp attributes.** In the element renderers (`renderP` and `buildTpl` and `pageAstro`), when emitting an element's attributes, ALSO emit: `data-role` (if `roleOfEl[id]`), `data-asset` (if the element is an `<img>`/bg with an alias), and on region-root elements `data-section="<role>"` + `data-component="<ComponentName>"`. Attributes are additive; do NOT change existing classes/attrs/order-of-existing. Escape values via `escA`.

- [ ] **Step 3 — `semantic.test.ts` assertions (data-*).** After `project()` on a golden site, parse `out.indexHtml`: assert `[data-section]` count ≥ regions, a `[data-role="primary-cta"]` exists (or the site's labeled CTA), `[data-component]` on each section root. (Use a real HTML parse or robust regex.)

- [ ] **Step 4 — PARITY GATE.** `pnpm vitest run` → the 6 parity-project tests MUST still be **0-px** (attributes are render-neutral). If any drift ≠ 0, an attribute changed layout (e.g. stamped on the wrong element / broke a selector) — fix. Also `tsc` clean.

- [ ] **Step 5 — commit** (`feat(clone-engine): stamp semantic data-* attributes (render-neutral, 0-px held)`).

---

## Task 2: Semantic component names from labels

**Files:** Modify `src/project.ts` (region naming); extend `test/semantic.test.ts`.

- [ ] **Step 1** — replace the copy-derived region `name` logic with `labels.sections[i].name` (fall back to the existing derivation when a section is `unknown`/unnamed). Keep the dedup + digit-prefix `S` safety. Component filenames + the `index.astro` imports use these names.

- [ ] **Step 2** — assert in `semantic.test.ts` that component files are named from labels (e.g. a `Testimonials*`/`Hero*` component exists for a site that has those sections), and NO `S<digit>Section` junk remains when labels named them.

- [ ] **Step 3 — GATE** — `pnpm vitest run` 0-px + the emitted Astro project still `astro build`s (the existing parity path builds it). `tsc` clean. Commit.

---

## Task 3: B — `brand.json` + token cascade (the coupling-risk step)

**Files:** Create `src/brand.ts`; modify `src/project.ts`, `src/types.ts`; Create `test/brand.test.ts`.

- [ ] **Step 1 — `brand.ts`.** `buildBrand(labels, CAP): BrandDoc` in `BrandTokens` shape (`colors:{primary,accent,surface,text,muted}` hex, `fonts:{display,body}`, `space`, `radius` best-effort/defaults). `brandTokenMap(brand): Map<canonColor, "--color-<slot>">` for the canonical slots only. `deriveVariants(brand, usedColors)`: for each canonical color appearing at other opacities/tints in the styles, emit `--color-<slot>-<NN>` derived tokens (value = the exact captured variant). `flattenRoot(brand, variants): string` → `:root{ --color-primary:#..; ...; --font-display:..; --color-primary-60:.. }` (reuse or reimplement `tokensToCss`).

- [ ] **Step 2 — rewrite in project.** Where project currently tokenizes colors to `var(--<colorName>)`, FIRST map any literal whose canon matches a canonical brand slot (or a derived variant) → `var(--color-<slot>[-NN])`; only non-canonical leftovers keep the existing per-literal `--<colorName>` tokens. Emit `:root` from `flattenRoot(...)` + the leftover palette tokens. Write `brand.json` to `OUT`.

- [ ] **Step 3 — `brand.test.ts`.** brand.json matches `BrandTokens` shape; every canonical slot resolves to a hex; a variant token's value equals the exact captured literal it replaced; editing `--color-primary` in the emitted `:root` would recolor all `var(--color-primary)` refs (assert ref count > 1 for the brand color).

- [ ] **Step 4 — PARITY GATE (critical).** `pnpm vitest run` → **0-px on all 3 sites**. This is where coupling bugs hide (a brand color mapped to a slot whose value differs by a hair, or a variant mis-derived, shifts pixels). If drift ≠ 0: the literal→slot mapping isn't byte-value-preserving — the mapped `var()` MUST resolve to the identical bytes as the original literal. Fix the mapping; never loosen the oracle. `tsc` clean. Commit.

---

## Task 4: `site.json` manifest

**Files:** Create `src/manifest.ts`; modify `src/project.ts`; extend `test/semantic.test.ts`.

- [ ] **Step 1 — `manifest.ts`.** `buildManifest({regions, labels, brand, base, assetMap}): SiteManifest` (add `SiteManifest` to types): `{ brand:"brand.json", pages:[{ route, component:"index.astro", sections:[{name,role,file}], elements:[{role,id:"p<n>",selector:"[data-role=..]"}], assets:[{alias,file}] }] }`. (`route` from `BASE` or "/".)

- [ ] **Step 2** — `project()` writes `site.json` to `OUT`. (Pure metadata — no render change.)

- [ ] **Step 3 — sanity test.** every `elements[].id` resolves to a real element in the output; every `assets[].file` exists on disk; every `sections[].file` is an emitted component. No `.pN` capture-id leakage into the manifest's public fields beyond the intended `id`/`selector` handles.

- [ ] **Step 4 — GATE** (0-px unchanged — metadata only), `tsc` clean, commit.

---

## Task 5: Copy wired to editable `content[]` via `data-copy` keys

**Files:** Modify `src/project.ts`; extend `test/semantic.test.ts`.

- [ ] **Step 1** — the components already extract text into a `content[]` array via `buildTpl` (`${e(content[i])}`). Give each text slot a **stable `data-copy` key** (e.g. `<component>.<n>` or a role-derived key) stamped on the nearest enclosing element, and record `copyKey → content index` so an editor can resolve "the hero headline" → the exact slot.

- [ ] **Step 2 — round-trip test.** Editing a `content[i]` value changes the rendered text at the element carrying its `data-copy` key (render the component with a mutated content array; assert the new text appears; assert the `data-copy` attribute maps to that slot).

- [ ] **Step 3 — GATE.** 0-px unchanged (keys are attributes; unedited content renders identically). `tsc` clean. Commit.

---

## Task 6: LLM labeler (enhancement; mocked in tests; heuristic fallback)

**Files:** Modify `src/labels.ts`, `package.json` (add `@milo/llm` dep); extend `test/labels.test.ts`.

- [ ] **Step 1 — digest.** `buildDigest(cap): object` — a compact JSON the LLM can label: top sections (tag, id, heading/copy snippet, has-images/forms/buttons), color palette + usage stats, fonts + context, assets + alt/placement. Keep it small (token budget).

- [ ] **Step 2 — LLM call.** `llmLabels(cap, chat, model): Promise<Labels>` using `llmJson(LabelSchema, { chat, model, messages:[system+digest] })` from `@milo/llm`. System prompt: "you ANNOTATE a faithful capture; assign section roles from THIS vocab, brand slots, element roles, asset aliases; never invent content." Model = `process.env.DEFAULT_LLM_MODEL` (gemini-2.5-flash), swappable.

- [ ] **Step 3 — wire fallback into `label()`.** `label({..., llm})`: if `llm !== false` AND `LLM_PROVIDER` set → try `llmLabels`, on ANY error fall back to `heuristicLabels` (log which was used). `--no-llm`/`llm:false` → heuristic. **LLM is never a hard dependency.**

- [ ] **Step 4 — tests (mock the LLM).** In `labels.test.ts`, inject a `fakeChat` (the `@milo/llm` test pattern) returning canned JSON → assert `llmLabels` validates + produces expected roles; assert a `fakeChat` that returns garbage → `label()` falls back to heuristic and still returns valid labels. NO real API calls in tests.

- [ ] **Step 5 — real eval (manual, not a gated test).** Run `label()` with the real LLM on the 3 golden captures; eyeball that section/brand/element labels are sensible; note quality in the commit. (Label quality is a soft target; fidelity is the hard gate — unaffected by label quality.)

- [ ] **Step 6 — DEGRADATION + PARITY GATE.** `pnpm vitest run` with no `LLM_PROVIDER` → projection uses heuristic labels → **0-px still holds**. `tsc` clean. Commit.

---

## Task 7: Integration sweep + hardening

**Files:** Modify `src/index.ts`, `README.md`; possibly small refactors.

- [ ] **Step 1 — full regression sweep.** `pnpm vitest run` (9 parity + labels + brand + semantic) all green. `pnpm exec tsc --noEmit` clean. `cd /Users/dan/pushpress/milo && pnpm -r test` all packages green.
- [ ] **Step 2 — CLI.** add a `label` subcommand (`node src/cli.ts label --dir <d> [--no-llm]`) and confirm `project` now emits `brand.json` + `site.json` + `labels.json` + semantic components + `data-*` for a golden site end-to-end. Export `label` + new types from `index.ts`.
- [ ] **Step 3 — README + DOCTRINE.** document the A+B outputs (labels.json / brand.json / site.json / data-* contract) in the package README; note the manifest is the interface C/D/E/F consume.
- [ ] **Step 3b — de-dup shared helpers (from T0/T1/T3 reviews).** `canon()` and `partitionRegions()` are duplicated byte-identically across `labels.ts`/`project.ts`/`brand.ts` (documented, drift-risk). Extract to a shared module (`src/tree.ts` / extend `src/html.ts`), import from all three. Also add a guard/comment for the unreachable 5/7-char hex branch in `canon` (T3 review). Output-neutral — 0-px must still hold.
- [ ] **Step 3c — astro-build → 0-px oracle (coverage gap from T5).** The pixel oracle currently tests the *assembled* index.html; but the shipped artifact is the *Astro build* (which carries the component structure + `data-copy` that the assembled version doesn't). Add a test that runs `astro build` on a projected site and diffs the built `dist` output vs the clone at 0-px (mirror the `.mjs`-era `astro-diff` approach) — so the REAL editable output is fidelity-verified, not just the flattened reference. (Needs the astro node_modules available; wire it in the test setup.)
- [ ] **Step 4 — manifest completeness check on all 3 sites** (every role→id + alias→file + section→component resolves). Commit + tag `plan2-AB-complete`.

---

## Done when
- A golden clone projects to: semantically-named components, `data-*` on elements/sections/assets/copy, a `brand.json` whose canonical tokens cascade, and a `site.json` manifest that fully resolves — with the **un-edited projection still 0-px** against the clone on all 3 sites.
- Heuristic path fully deterministic + tested; LLM path validated (mocked) with graceful fallback; degradation (no-LLM) holds 0-px.
- `tsc` clean, workspace green, README updated, tagged `plan2-AB-complete`.
- **Not proven here (by design):** agent-editing at scale — that's Plan 3 / subsystem C.
