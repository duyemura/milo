# Subsystem C — LLM Edit Operations (v1)

**Date:** 2026-08-02
**Status:** Design — approved in brainstorming, pending written-spec review
**Engine:** `@milo/clone-engine` (`packages/clone-engine`)
**Depends on:** Plan 2 substrate (`site.json`, `brand.json`, `data-*`, the projected Astro artifact), `@milo/llm`
**Doctrine:** `packages/clone-engine/DOCTRINE.md`; scope: `project_agent_editing_scope` memory
**Validated by:** the C vertical slice (`packages/clone-engine/experiments/edit-slice/`) — copy + brand edits proven scoped-diff-safe

## Purpose

Let an LLM agent make a **natural-language edit to one cloned site**, safely — the product bet. The user (via the admin chat) says "make the CTAs blue" or "add a Brooklyn location page"; C plans it, shows a preview, applies it on confirmation, and a **verifier proves the intended change landed and nothing else broke**. Per-site only.

## Acceptance definition (the bet)

An agent reliably makes the correct requested change to an arbitrary site — structurally, repeatably, generally — while a fidelity mechanism guarantees everything it didn't intend to touch stays pixel-identical, so unsafe edits are **caught, not shipped**. Per-site; **never batch/fleet-wide** (hard scope guardrail — no cross-site "apply to all" op exists).

## Scope (v1)

**In:** edit existing content + duplicate-to-add. No from-scratch generation.

Edit-op set (all deterministic mutations over the Plan-2 contract; the LLM only *selects* op + targets):

| Op | Does | Mechanism |
|---|---|---|
| `editCopy` | change a text string | rewrite `content[i]` in the component (proven) |
| `setBrand` | recolor a brand token slot | edit `brand.json` tokens + regen `:root` (proven) |
| `swapAsset` | replace an image/logo | swap the `assets/` file by `data-asset` alias |
| `styleTweak` | bounded style change (font-size, spacing) on a role/section | edit the section's scoped CSS |
| `removeSection` | delete a section | remove component + its `index.astro` include; update `site.json` |
| `reorderSection` | move a section | reorder `index.astro` includes; update `site.json` |
| `addSection` | add a section by **cloning an existing one** | duplicate a component, then `editCopy` its content |
| `addPage` | add a page by **cloning a template page** | duplicate a page's route+components, then `editCopy` for the new topic |
| `revert` | undo the last apply (or to a version) | restore the pre-edit snapshot / apply inverse ops |

**Out (deferred):** from-scratch generation of new sections/pages (subsystem **E**); full brand-*kit* authoring — voice/imagery/positioning as first-class (a **B**-expansion; see Brand model); page types + goals (**D**); measurement (**F**); the chat UI (admin side).

## Architecture — two-phase, verifier-gated, self-correcting

A "site" = a projected Astro project (an `OUT` dir from `project()`: components + `site.json` + `brand.json`). Edits mutate those files; the verifier re-renders.

```
admin router ──"make it pop"──▶ C.plan(site, conversation)
                                 │  planner LLM: clear enough? → produce ops.  vague? → ASK.
                                 ▼
                        {needsInfo, questions[]}  ──▶ admin asks user → answers ──▶ C.plan(...)  (loop)
                                 │  (once intent + WHY are clear)
                                 ▼
                        {ready, ops[], summary}  ──▶ admin shows TEXTUAL summary → CONFIRM
                                 │
admin ──C.apply(site, ops)─────▶ apply ops (deterministic) → verify (per-section)
                                 │  PASS → commit; FAIL → feed verifierReport to LLM →
                                 │  revise WITHIN confirmed intent → re-verify (bounded)
                                 │  still FAIL → surface to human + diff (never silently deviate)
                                 ▼
                        {result, verifierReport, opsApplied}  ──▶ user sees LIVE result → iterate / revert
```

## The verifier — per-section internal fidelity

Given the edit's intended target sections, for each `apply`:
- **Untouched sections** — cropped by their `data-section` bounding box, rendered before/after, must be **0-px internally** (position-independent, so a section that reflows/shifts is fine as long as it renders identically inside).
- **Edited section(s)** — op-specific intended-change check (copy: the target text changed + rest of the section 0-px; brand: the recolor tracks the delta-vector; etc.) *and* the section still renders coherently.
- **Structural** — the section set after the edit = intended (removed gone, added present, order correct) per `site.json` + the DOM.
- **Render-sanity** — page builds; no overlapping boxes / layout errors.
- **Negative control (non-negotiable):** the verifier must be *falsifiable*. The test suite includes edits that SHOULD fail (a corrupting edit, a wrong target) and asserts the verifier catches them (≥ some collateral threshold). A verifier that can't fail is worthless. (The slice proved a mismatched edit flags ~99% collateral.)

This is the never-regress rule (`DOCTRINE.md`) generalized from a static clone to a *mutable* site: an edit produces an intended diff on its target and 0-px on everything else.

## Plan phase — clarifying dialogue, then a textual plan (no visual mock)

Most edit requests are underspecified ("make it pop", "add a page"). So the plan phase is a **brainstorming-style clarifying dialogue**, not a one-shot guess. `plan(site, conversation) → { needsInfo, questions } | { ready, ops, summary }`:
- Build a compact digest: `site.json` (sections/roles/copy-previews/element roles/assets) + `brand.json` + the conversation so far + the op schema.
- The planner LLM (via `@milo/llm` `llmJson`) decides, like a brainstormer: **clear enough → produce `ops[]` + a plain-language `summary`; vague → return 1–3 targeted `questions`** to pin down *what* the user wants and *why* (e.g. "add a location page" → "Which location? Address & hours? Match your existing location pages?"). The admin chat presents the questions, collects answers, and calls `plan` again with the extended conversation — looping until intent is clear.
- **No visual mock.** We deliberately do NOT render a preview image. Understanding intent via dialogue beats anchoring on a guessed mock; the user confirms the **textual `summary`** ("I'll change the hero headline to X, recolor primary to blue, add a Brooklyn page cloned from Hell's Kitchen"), then sees the **live result** after `apply` and iterates. (The verifier guarantees *safety*; the dialogue guarantees we build the *right* thing; `revert` covers *taste* — see below.)
- Every op's targets are validated against the real `site.json`/contract — a hallucinated target is rejected before it touches a file.
- **C owns the NL→ops LLM call** (deep `site.json` knowledge). The admin's intent-router only decides "this is an edit request → forward the conversation to `C.plan`" — no overlapping edit-LLM on the admin side.

## Apply phase + self-correction

`apply(site, confirmedOps) → { result, verifierReport, opsApplied }`:
- Apply the confirmed ops (deterministic mutations).
- Verify (per-section). PASS → commit.
- FAIL → feed the specific verifier failure back to the LLM → it revises → re-verify. **Bounded retries.**
- **Safety rule:** self-correction stays *within the confirmed intent* — it retries the same edit differently; it does NOT invent a new edit the user didn't approve. If it cannot make the confirmed edit pass within the retry budget, it **surfaces to the human** with the scoped-diff (never silently ships a partial/deviating result).
- **What "confirm" means:** because `apply` self-corrects, the confirm is a contract on the **outcome/intent** (the textual summary), not on the byte-exact final ops — self-correction may change the *mechanism* to make the change land, but it preserves the confirmed *outcome* or surfaces. ("Yes, make it look like this" → the engine guarantees that outcome or asks.)
- **Reversibility:** every `apply` is undoable. Before mutating, snapshot the site (or record inverse ops); a `revert(site)` (or `revert(site, toVersion)`) restores the prior state. This is the safety net for the no-mock "apply → see live result → iterate" flow — the user can always undo an edit they don't like.

## Brand model (from the "brand is more than color/logo" discussion)

`brand.json` is a **brand kit** with two kinds of fields:
- **`tokens`** (colors / fonts / space / radius) — drive `:root`, **automatic CSS cascade**. `setBrand` edits these (works today).
- **`voice` / `imagery` / `positioning` / `logo`** (reserved in v1) — **guidance** the LLM reads when doing copy/asset edits, NOT an automatic cascade. Changing voice doesn't rewrite existing copy unless asked (a future `reapplyVoice` op would).

A holistic request ("make my brand more premium") is decomposed by the planner into a **multi-op plan**: `setBrand` (palette/fonts/spacing) + `editCopy` (voice) + `swapAsset` (imagery) — one plan, one confirm, verifier checks each. v1 ships token `setBrand`; the brand-kit fields are structured/reserved now and authored first-class in the B-expansion (populated from the gym's business context — ties to the admin's brand-kit/PageBrief work).

## addPage / addSection by cloning

- `addSection`: clone an existing section component (nearest-role match, or a specified source), insert it, then `editCopy` its content for the new purpose.
- `addPage`: clone a **template page** — **auto-pick the nearest-type existing page** (e.g. an existing location page for "add a Brooklyn location page"), with **user/admin override** to specify the source page. Duplicate its route + components, then `editCopy` for the new topic. New page enters `site.json` + routing.

## API seam (C ↔ admin)

Typed entrypoints the admin chat calls:
- `plan(siteRef, conversation) → { needsInfo, questions } | { ready, ops, summary }` — iterative clarifying dialogue → textual plan.
- `apply(siteRef, ops) → { result, verifierReport, opsApplied }` — verify + self-correct.
- `revert(siteRef, toVersion?) → { result }` — undo the last apply (or to a version).
- (low-level ops + `verify` also exported for advanced/testing use; an optional convenience `applyRequest` wrapper can do `plan`+auto-`apply` for the no-confirm proactive case.)

The admin owns: the chat UX, the confirm step, the ~2000-site plane. The engine owns: NL→ops planning, the ops, the verifier, self-correction, dry-run. No deploys of edited output without human authorization (shared-infra rule).

## Testing

- **Scenario suite:** one end-to-end test per op (plan → apply → verify) on a golden projected site, with **reflow cases** (remove/reorder/add-section, add-page) as the emphasis (they exercise the per-section-internal-fidelity verifier under reflow).
- **Negative controls:** edits that should fail (corrupt a component, target the wrong section, a brand edit that leaks) → assert the verifier catches them.
- **Determinism:** the ops are deterministic; the LLM planner is mocked in tests (real-LLM eval separate). Self-correction loop tested with a fake verifier-fail → revise path.
- Fidelity floor: the plan-2 pixel oracle on the un-edited baseline still holds.

## File structure (proposed)

```
packages/clone-engine/src/edit/
  ops.ts          # editCopy, setBrand, swapAsset, styleTweak, removeSection, reorderSection, addSection, addPage — deterministic
  verify.ts       # per-section internal fidelity + structural + render-sanity + negative-control helpers
  plan.ts         # clarifying dialogue → ops+summary OR questions (llmJson + op schema); NO visual mock
  apply.ts        # apply → verify → self-correct loop
  revert.ts       # snapshot/restore (or inverse ops) — undo an apply
  digest.ts       # compact site digest for the planner
  types.ts        # EditOp union, Plan, VerifierReport, PlanResult (needsInfo|ready), etc.
  index.ts        # plan(), apply(), revert(), + op/verify exports
test/edit/        # scenario suite + negative controls (mocked LLM) + revert round-trip
```

## Non-negotiable invariants

- **The verifier is the gate and it is falsifiable.** No edit ships without passing per-section verification; the verifier is proven able to fail (negative controls).
- **Per-site only.** No batch/fleet mutation op exists.
- **Self-correction never deviates from confirmed intent.** It retries or surfaces — never silently does something else. Confirm is a contract on the *outcome*, not the literal ops.
- **Every apply is reversible.** A snapshot (or inverse ops) is recorded before mutating; `revert` restores it. Enables the no-mock "apply → see → iterate" flow.
- **Fidelity floor unchanged:** the un-edited projection still diffs 0-px (Plan 2 oracle); edits produce intended-diff-on-target + 0-px-elsewhere.
