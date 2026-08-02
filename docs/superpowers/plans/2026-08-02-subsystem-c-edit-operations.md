# Subsystem C — Edit Operations (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking. Fidelity gate: the Plan-2 pixel oracle on the UN-edited baseline must stay 0-px; edits produce intended-diff-on-target + 0-px-elsewhere, proven by the per-section verifier (Task 3), which must be *falsifiable* (negative controls).

**Goal:** Let an LLM agent make a natural-language edit to ONE cloned site safely — plan (clarifying dialogue → ops) → confirm → apply (verify + self-correct) → reversible.

**Architecture:** A new `src/edit/` module over the Plan-2 contract (`site.json` + `brand.json` + `data-*` + the projected Astro artifact). Deterministic edit **ops** mutate the site; a **verifier** proves per-section internal fidelity (untouched sections render pixel-identical internally, position-independent → reflow-safe); a **plan** phase (LLM, mocked in tests) turns NL into ops or clarifying questions; an **apply** phase runs ops → verifies → self-corrects within confirmed intent; every apply is **reversible**.

**Tech stack:** Node 24 native TS, `@milo/clone-engine`, `@milo/llm` (`llmJson`), Playwright (screenshots/diff — reuse `src/pixel.ts`), Vitest (`--no-file-parallelism`). Spec (authoritative): `docs/superpowers/specs/2026-08-02-subsystem-c-edit-operations-design.md`. Reference PoC: `experiments/edit-slice/` (copy+brand proven).

**Test setup pattern (all tasks):** project a golden to a temp dir, run ops on it, verify. Helper `projectFixture(golden)` → temp OUT dir (mirror `experiments/edit-slice/` + `test/astro-build.test.ts` for the astro build + screenshot plumbing). LLM is always **mocked** (`fakeChat`); real-LLM eval is a separate manual step.

---

## File structure

```
packages/clone-engine/src/edit/
  types.ts     # EditOp union, PlanResult, VerifierReport, SiteRef, EditResult
  target.ts    # resolve a target (copyKey / role / data-asset / section) against site.json → concrete file+locus
  ops.ts       # deterministic mutations: editCopy, setBrand, swapAsset, styleTweak, removeSection, reorderSection, addSection, addPage
  verify.ts    # per-section internal fidelity + edited-section op-check + structural + render-sanity
  snapshot.ts  # snapshot/restore a projected site dir (for revert)
  digest.ts    # compact site digest for the planner
  plan.ts      # clarifying dialogue: (site, conversation) -> {needsInfo, questions} | {ready, ops, summary}
  apply.ts     # apply ops -> verify -> self-correct (within intent) -> surface; revert
  index.ts     # plan(), apply(), revert(), + op/verify/type exports
test/edit/
  ops.test.ts  scenario/*.test.ts  verify.test.ts  plan.test.ts  apply.test.ts
```

Sequencing: types → deterministic non-reflow ops → **verifier** (crux) → reflow ops (gated by verifier) → clone ops → snapshot/revert → plan (mocked LLM) → apply (self-correct loop) → API + integration.

---

## Task 0: Scaffold `src/edit/` + types

**Files:** Create `src/edit/types.ts`, `src/edit/index.ts`; Test `test/edit/types.test.ts`.

- [ ] **Step 1 — types.** In `types.ts`:
```ts
import type { z } from "zod";
export interface SiteRef { dir: string; }              // a projected OUT dir
export type EditOp =
  | { op: "editCopy"; copyKey: string; text: string }
  | { op: "setBrand"; slot: "primary"|"accent"|"surface"|"text"|"muted"; value: string }
  | { op: "swapAsset"; alias: string; source: string }   // source = file path or URL of the new asset
  | { op: "styleTweak"; target: string; prop: string; value: string }  // target = data-role/section; prop ∈ bounded set
  | { op: "removeSection"; section: string }             // section = data-section role or component name
  | { op: "reorderSection"; section: string; toIndex: number }
  | { op: "addSection"; cloneOf: string; afterSection?: string }
  | { op: "addPage"; route: string; cloneOfPage?: string };  // cloneOfPage optional → auto-pick nearest-type
export interface OpResult { op: EditOp; changedFiles: string[]; targetSections: string[]; }
export interface PlanResult {
  needsInfo: boolean;
  questions?: string[];               // when needsInfo
  ops?: EditOp[]; summary?: string;   // when ready
}
export interface SectionDiff { section: string; changed: boolean; inScopePx: number; outScopePx: number; }
export interface VerifierReport {
  pass: boolean;
  sections: SectionDiff[];
  structural: { expected: string[]; actual: string[]; ok: boolean };
  renderSane: boolean;
  failures: string[];                 // human-readable reasons (fed to self-correction)
}
export interface EditResult { ok: boolean; verifierReport: VerifierReport; opsApplied: EditOp[]; reverted?: boolean; }
export const STYLE_PROPS = ["font-size","font-weight","font-style","text-align","padding","margin","background-color","color","width","max-width","display","grid-template-columns","gap"] as const;
```

- [ ] **Step 2 — barrel.** `index.ts`: `export * from "./types.ts";` (extended per task).

- [ ] **Step 3 — test.** `types.test.ts`: trivially import the types + assert `STYLE_PROPS` includes `"font-size"` and `"grid-template-columns"` (sanity that the bounded set exists). Run `pnpm vitest run --no-file-parallelism test/edit/types.test.ts` → green.

- [ ] **Step 4 — gate + commit.** `node_modules/.bin/tsc --noEmit` clean. Commit `feat(edit): scaffold src/edit + edit-op types (C-T0)`.

---

## Task 1: Target resolution + non-reflow ops `editCopy`, `setBrand`

**Files:** Create `src/edit/target.ts`, `src/edit/ops.ts`; Test `test/edit/ops.test.ts`.

- [ ] **Step 1 — `target.ts`.** `resolveCopy(site, copyKey) → { file, contentIndex }` (look up `site.json.pages[].copy[]`), `resolveSection(site, section) → { file, name }`, `resolveElement(site, role) → { selector, component }`, `resolveAsset(site, alias) → { file }`. Each throws a typed `TargetError` if the handle isn't in `site.json` (the hallucination guard — a bad target never touches a file).

- [ ] **Step 2 — `editCopy` + `setBrand` in `ops.ts`** (productionize the proven `experiments/edit-slice/edit-ops.mjs`):
```ts
export function editCopy(site: SiteRef, copyKey: string, text: string): OpResult;  // rewrite content[index] in the component .astro
export function setBrand(site: SiteRef, slot: string, value: string): OpResult;    // edit astro/brand.json colors[slot].value(+hex, recompute alpha variants) → regen :root via flattenRoot
```
Reuse `buildBrand`/`flattenRoot`/`canon` from `../brand.ts` for `setBrand` (don't reinvent the cascade). `editCopy` reads `resolveCopy`, mutates the component's `content` array (parse the `const content = [...]` literal safely, replace element `index`, rewrite).

- [ ] **Step 3 — tests** (TDD, write first): project speakeasy fixture; `editCopy(site, someCopyKey, "SENTINEL")` → assert the component file now contains SENTINEL at that content index + `changedFiles` correct. `setBrand(site, "primary", "#1e40af")` → assert `astro/brand.json` primary.value updated + `:root` in `global.css` now has the new value + a leftover token unchanged. `resolveCopy` with a bogus key throws `TargetError`.

- [ ] **Step 4 — gate + commit.** tests green, tsc clean. Commit `feat(edit): target resolution + editCopy/setBrand ops (C-T1)`.

---

## Task 2: Non-reflow ops `swapAsset`, `styleTweak`

**Files:** Modify `src/edit/ops.ts`; extend `test/edit/ops.test.ts`.

- [ ] **Step 1 — `swapAsset`.** `swapAsset(site, alias, source)`: `resolveAsset` → the current `assets/aN.ext` file; copy the new `source` (local path or downloaded URL) into `assets/`, replacing that file (keep the same filename so all refs resolve; re-run the same magic-byte type check as capture's `sniffExt` if the extension differs — if type differs, write a new filename + rewrite refs to it). Return changed files.

- [ ] **Step 2 — `styleTweak` (bounded + prefer-brand-tokens).** `styleTweak(site, target, prop, value)`: validate `prop ∈ STYLE_PROPS` (throw otherwise — bounded). Resolve the target's `data-role`/section → its scoped CSS rule in the component/global.css; set `prop: value`. **Prefer brand tokens:** if `prop` is a color/spacing and `value` matches (canon-equal) a brand token, emit `var(--color-<slot>)` / `var(--space-<x>)` instead of the literal. Append/override the rule scoped to that element's `.pN` class (so it's local, not global).

- [ ] **Step 3 — tests:** `swapAsset(site, "logo", <a test png>)` → the logo file bytes changed, refs still resolve. `styleTweak(site, "primary-cta", "font-size", "24px")` → the CTA's rule has font-size:24px. `styleTweak(..., "background-color", "<the brand primary hex>")` → emits `var(--color-primary)` (brand-token preference). `styleTweak(..., "not-allowed-prop", ...)` throws (bounded).

- [ ] **Step 4 — gate + commit.** tests green, tsc clean. Commit `feat(edit): swapAsset + bounded styleTweak ops (C-T2)`.

---

## Task 3: The verifier — per-section internal fidelity (THE crux)

**Files:** Create `src/edit/verify.ts`; Test `test/edit/verify.test.ts`.

- [ ] **Step 1 — `snapshotRender(site)`.** Build the astro project (reuse `test/astro-build.test.ts` / `scripts/astro-oracle.mjs` plumbing — symlink shared astro node_modules) OR render the assembled `index.html`; return a page handle. For each section (from `site.json` sections, located in the DOM by `[data-component="<file basename>"]` / `[data-section]`), record its **bounding box** + a **cropped screenshot** of that box. Also a full-page screenshot.

- [ ] **Step 2 — `verify(before, after, intent)`** where `intent = { editedSections: string[]; op: EditOp }`:
```ts
export async function verify(browser, siteBefore: SiteRef, siteAfter: SiteRef, intent): Promise<VerifierReport>
```
Algorithm:
1. `snapshotRender` before + after.
2. **Structural:** the set of sections after == expected (removed gone, added present, order per intent) from `site.json` + DOM. If not → fail.
3. **Per untouched section** (not in `intent.editedSections`): crop it by its OWN bounding box in before and in after (position-independent — a section that moved renders its own box), `pixelDiff` the two crops → must be **0-px**. Non-zero → `outScopePx > 0` → fail (unless it's an added/removed neighbor, handled structurally).
4. **Per edited section:** op-specific intended-change check — copy: the target text changed AND the rest of the section (mask the text region) is 0-px; setBrand: the recolor tracks the delta-vector (reuse `experiments/edit-slice/verify-scoped.mjs` recolor logic); swapAsset: the image region changed, rest 0-px; styleTweak: bounded; and the section still renders coherently.
5. **Render-sanity:** page built without error; no overlapping section boxes (bounding boxes don't intersect beyond a tolerance).
6. Aggregate → `VerifierReport{ pass, sections, structural, renderSane, failures }`.

- [ ] **Step 3 — negative-control tests (non-negotiable — the verifier MUST be falsifiable):**
  - A CLEAN edit (editCopy on a golden) → `verify` **pass**, edited section changed, all others 0-px.
  - A CORRUPTING edit (e.g. inject a style into an UNRELATED section, or a brand edit that leaks into text) → `verify` **FAIL** (outScopePx > 0 on an untouched section). Assert the verifier catches it.
  - A REFLOW edit (removeSection) → surviving sections that moved still verify **0-px internally** (position-independent) → pass; the removed section is accounted for structurally.
  - Assert `verify` returns actionable `failures[]` strings (used by self-correction later).

- [ ] **Step 4 — gate + commit.** verify tests green (incl. the must-fail negative control), tsc clean. Commit `feat(edit): per-section internal-fidelity verifier + negative controls (C-T3)`.

---

## Task 4: Reflow ops `removeSection`, `reorderSection` (gated by the verifier)

**Files:** Modify `src/edit/ops.ts`; scenario `test/edit/scenario/reflow.test.ts`.

- [ ] **Step 1 — `removeSection`.** Remove the component `.astro` file + its `<Component/>` include from `index.astro`; drop it from `site.json.sections` (+ its copy/elements). `reorderSection`: move the include in `index.astro`; reorder `site.json.sections`.

- [ ] **Step 2 — scenario tests (end-to-end, verifier-gated):** project speakeasy; `removeSection(site, "<a section role>")` → re-project/rebuild → `verify(before, after, {editedSections:[removed], op})` **passes** (surviving sections 0-px internal despite reflow; structural shows the section gone). `reorderSection` similar. A `removeSection` that accidentally corrupted a sibling (simulate) → verify fails.

- [ ] **Step 3 — gate + commit.** tests green, tsc clean, Plan-2 oracle still 0-px on the un-edited baseline. Commit `feat(edit): removeSection + reorderSection (reflow, verifier-gated) (C-T4)`.

---

## Task 5: Clone-to-add ops `addSection`, `addPage`

**Files:** Modify `src/edit/ops.ts`, `src/edit/target.ts`; scenario `test/edit/scenario/clone.test.ts`.

- [ ] **Step 1 — `addSection(cloneOf, afterSection?)`.** Duplicate the `cloneOf` section's component (new unique name, new `.pN`-collision-free classes if needed — or reuse with a suffix), insert its include after `afterSection` (or at end); add to `site.json`. The caller then `editCopy`s the new section's content.

- [ ] **Step 2 — `addPage(route, cloneOfPage?)`.** If `cloneOfPage` omitted, **auto-pick the nearest-type page** — `pickTemplatePage(site, route)`: match by page role/type (e.g. an existing location page for a location route) via `site.json` page metadata / route pattern; fall back to the home page. Duplicate that page's route dir + components; register the new route in `site.json` + astro pages; rewrite internal self-refs. The caller then `editCopy`s for the new topic.

- [ ] **Step 3 — scenario tests:** `addSection(site, cloneOf=<existing section>)` → new section present in `site.json` + renders; verifier: the new section is `editedSections`(added), others 0-px. `addPage(site, "/locations/brooklyn", cloneOfPage="/locations/hells-kitchen")` → new route exists, builds, renders; `pickTemplatePage` auto-picks a location page when `cloneOfPage` omitted (unit test).

- [ ] **Step 4 — gate + commit.** tests green, tsc clean. Commit `feat(edit): addSection + addPage by cloning a template (C-T5)`.

---

## Task 6: Snapshot / revert

**Files:** Create `src/edit/snapshot.ts`; Test `test/edit/revert.test.ts`.

- [ ] **Step 1 — `snapshot(site) → token` + `restore(site, token)`.** Copy the projected site dir to a versioned snapshot store (`<site>/.edit-history/<n>/`), return a token; `restore` copies it back. Keep the last K snapshots. `revert(site, toVersion?)` = restore the last (or a specific) snapshot.

- [ ] **Step 2 — round-trip test:** snapshot → `editCopy` a change → assert changed → `revert` → assert byte-identical to the snapshot (the edit is fully undone).

- [ ] **Step 3 — gate + commit.** tests green, tsc clean. Commit `feat(edit): snapshot + revert (reversible edits) (C-T6)`.

---

## Task 7: `plan` — clarifying dialogue (mocked LLM)

**Files:** Create `src/edit/digest.ts`, `src/edit/plan.ts`; Test `test/edit/plan.test.ts`.

- [ ] **Step 1 — `digest(site)`.** Compact JSON for the planner: `site.json` sections (name/role/copyKeys with previews), elements (role), assets (alias), brand slots. Small (token budget).

- [ ] **Step 2 — `plan(site, conversation, chat, model): Promise<PlanResult>`.** `llmJson` with a schema forcing EITHER `{needsInfo:true, questions:[...]}` OR `{needsInfo:false, ops:[...], summary}`. System prompt: "You edit ONE gym site. Given the digest + conversation, if the request is clear, output ops from the schema + a plain-language summary. If vague/underspecified, ask 1–3 clarifying questions to understand WHAT they want and WHY. Never invent targets — only reference real copyKeys/roles/sections/aliases/slots from the digest." **Post-validate every op target against `site.json`** (via `target.ts` resolvers) — drop/reject hallucinated targets; if all dropped, downgrade to `needsInfo` with a clarifying question.

- [ ] **Step 3 — tests (MOCKED LLM via `fakeChat`):** a clear request + a `fakeChat` returning valid ops → `plan` returns `{ready, ops, summary}` with validated targets. A vague request + a `fakeChat` returning questions → `{needsInfo, questions}`. A `fakeChat` returning an op with a bogus copyKey → target validation drops it / downgrades to needsInfo. NO real API.

- [ ] **Step 4 — gate + commit.** tests green, tsc clean. Commit `feat(edit): plan phase — clarifying dialogue + target validation (mocked LLM) (C-T7)`.

---

## Task 8: `apply` — self-correcting loop

**Files:** Create `src/edit/apply.ts`; Test `test/edit/apply.test.ts`.

- [ ] **Step 1 — `apply(site, ops, {chat, model, maxRetries=2}): Promise<EditResult>`.**
```
snapshot(site)
apply each op deterministically (ops.ts) → editedSections
verify(beforeSnapshot, site, {editedSections, ops})
  PASS → return {ok:true, verifierReport, opsApplied}
  FAIL → up to maxRetries:
           feed verifierReport.failures + the confirmed ops back to the LLM (llmJson)
           → it returns REVISED ops WITHIN the same intent (schema-constrained to the same op types/targets)
           → restore(snapshot); apply revised; re-verify
         still FAIL → restore(snapshot); return {ok:false, verifierReport, reverted:true}  (never ship a broken edit)
```
**Safety:** the revise call is constrained to the confirmed intent (same targets/op-kinds); it cannot introduce a new unrelated edit. On exhaustion, the site is reverted to the pre-apply snapshot (no partial/broken state shipped) and surfaced.

- [ ] **Step 2 — tests (MOCKED LLM):** a clean op → `apply` PASS, no retry. An op whose first application fails verify + a `fakeChat` that returns a fixed revision that passes → `apply` PASS after one retry. An op that keeps failing (fakeChat returns non-fixing revisions) → `apply` returns `{ok:false, reverted:true}` and the site is byte-identical to before (fully reverted). Assert the revise call only ever proposes ops within the original intent.

- [ ] **Step 3 — gate + commit.** tests green, tsc clean. Commit `feat(edit): apply — self-correcting loop, reverts on exhaustion (C-T8)`.

---

## Task 9: API + integration + real-LLM eval

**Files:** Modify `src/edit/index.ts`, `src/index.ts`; scenario `test/edit/scenario/integration.test.ts`.

- [ ] **Step 1 — API surface.** `src/edit/index.ts` exports `plan`, `apply`, `revert`, the ops, `verify`, and all types. Re-export from the package `src/index.ts` (namespaced, e.g. `export * as edit from "./edit/index.ts";`). Confirm the seam matches the spec: `plan(site, conversation)`, `apply(site, ops)`, `revert(site, toVersion?)`.

- [ ] **Step 2 — integration scenarios (mocked LLM, end-to-end):** for speakeasy — (a) copy edit, (b) brand recolor, (c) removeSection, (d) addPage-by-clone — each: `plan` (mocked → ops) → `apply` → assert PASS + the change is live + verifier clean; then `revert` → back to baseline. This is the productionized vertical slice across all op kinds.

- [ ] **Step 3 — real-LLM eval (MANUAL, not gated).** With the real OpenRouter key: run `plan` on 2–3 real NL requests ("make the CTAs blue", "add a Brooklyn location page", "make it pop") on a projected speakeasy; report what ops/questions the model produced + whether `apply` landed them cleanly. Honest: note any where it picked wrong or the verifier flagged.

- [ ] **Step 4 — full sweep + tag.** `pnpm vitest run --no-file-parallelism` (whole clone-engine suite incl. edit) green; `pnpm -r test` green; `tsc --noEmit` clean; Plan-2 oracle still 0-px. Commit + tag `subsystem-c-v1`.

---

## Done when
- `plan(site, conversation)` → clarifying questions when vague, validated ops+summary when clear (LLM mocked in tests; real-eval reported).
- `apply(site, ops)` → applies + per-section-verifies + self-corrects within intent + reverts-on-exhaustion; never ships a broken edit.
- All 8 ops (editCopy/setBrand/swapAsset/styleTweak/remove/reorder/addSection/addPage) work end-to-end, verifier-gated; `revert` undoes any apply.
- The verifier is **falsifiable** (negative controls fail as they must); reflow edits verify via per-section internal fidelity.
- Per-site only; Plan-2 fidelity floor intact (un-edited 0-px). Tagged `subsystem-c-v1`.
- **Not in v1:** from-scratch generation (E), full brand-kit voice/imagery authoring (B-expansion), page types/goals (D), measurement (F), the chat UI (admin).
