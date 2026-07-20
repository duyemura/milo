# Template IR — faithful template reproduction from a live URL

**Date:** 2026-07-20
**Status:** Approved design (brainstorm), pre-plan
**Supersedes:** the hand-authored template approach (`templates/modern`, `templates/blackout`) deleted 2026-07-20.

## Problem

Milo must turn a live gym website URL into a **generic, reusable website template** that reproduces the original's structure, look, and (eventually) interactions **faithfully** — where "faithful" is a machine-verifiable fact, not an LLM's opinion.

v1 stalled at ~78/100 for two weeks because it asked an LLM to imagine a good site and then grade its own imagination. v2's first attempt (hand-authored `modern` / `blackout` templates) produced style *families*, not reproductions: pixel values were hand-transcribed into component CSS (`padding: 270px`, `font-size: 49px`), so each template was close-but-never-right and could not generalize.

## Goal / Non-goals

**Goal:** point `capture` at a reference URL → produce a **Template IR** (typed JSON) → render a static site from it → prove fidelity against the source with **objective, computable gates**, iterating via a fix loop until every gate passes.

**Non-goals (for now):** the site/content layer (a specific gym's facts), `generate`, `publish`/AWS, leads, AI assistant. Pixel-perfect cloning of bespoke animation/canvas work — out of scope by design; the target is *recognizably the same site*, reusable as a template.

## Core principles (non-negotiable)

1. **Re-measure, never eyeball.** Eval runs the *same* Playwright extractor on the rendered site and compares numbers to the source's numbers.
2. **The LLM is never the scorer.** Code adjudicates pass/fail against checked-in thresholds. The LLM only (a) classifies structure during extract and (b) localizes an already-failed discrepancy to author a fix instruction.
3. **No value without provenance.** Every value in the IR traces to a source measurement (e.g. `getComputedStyle` on a selector). Un-sourced values fail the build. This is what stops the LLM from inventing numbers.
4. **Typed JSON only for anything authoritative.** Zod-validated, closed vocabulary. Prose is allowed *only* as non-authoritative human notes that no downstream step reads as truth — prose is the fudge substrate.
5. **Fail loud.** If the fix loop can't converge in N iterations, it hard-fails and emits the exact table of failing properties. It never rounds up to please. Waivers are per-gate and recorded; there is no global fuzzy dial.

## Architecture — components (each a unit with one job and a typed boundary)

```
capture ─→ assets ─→ extract ─→ render ─→ align ─→ eval ─→ fix ──┐
                                                                 │
   controller: thresholds · iteration budget · pass/fail ledger · fail-loud · waivers
                                                                 └── re-render instructions loop back
```

- **capture** — extend the kept `apps/studio/src/capture.mjs`. Adds **per-section DOM subtree + computed styles** (today it dumps only page-global type + a flat section list), at both viewports (1440 / 375). Records interaction states (dropdown, mobile-menu, accordion) as artifacts even during the static phase, so Phase 2 needs no re-crawl. Output: a capture bundle (existing shape + per-section detail).
- **assets** — download and self-host the exact fonts and images referenced by the source; emit a local asset map. Prerequisite for typographic and perceptual eval (can't measure fidelity against a font you didn't load).
- **extract** — capture bundle → **Template IR**. Deterministic code fills every measured value; the LLM classifies structure (which archetype/variant a section is) and names intent. Provenance-tagged.
- **render** — Template IR → static site via Astro components **parameterized by the IR**. Each component written once, correctly; renders any IR. Replaces hand-authored templates.
- **align** — builds the source↔render **correspondence map** (section N ↔ section N). Prerequisite for precise diffing; if counts/order drift, pixel numbers are meaningless.
- **eval** — re-measures the rendered site and compares to source measurements against checked-in thresholds. Emits a per-property pass/fail ledger.
- **fix** — consumes failing properties → targeted re-render/re-extract instructions → loops.
- **controller** — owns thresholds, iteration budget, the ledger, fail-loud behavior, and recorded per-gate waivers.

## The Template IR (the document layer)

Typed JSON; supersedes the old hand-authored template + `TemplateManifest`. Lives in `packages/schema`, same Zod-contract discipline as `GymSiteContent`.

- **tokens** — type scale keyed by role (family, size, weight, line-height, tracking, transform, color); palette by role; spacing scale; radii; shadows; font sources.
- **sections** — ordered array; each: `archetype` + `variant` + measured layout params (columns, padding, bg, media side, alignment) + content slots + asset refs.
- **hierarchy** — nav tree / sitemap as a JSON tree.
- **interactions** — *(Phase 2)* typed specs: dropdown, mobile-menu, accordion, sticky-nav, hover.
- Every field Zod-validated, closed vocabulary, provenance-tagged. Unknown archetype or un-sourced value → build fails.

## Eval — the gate ledger ("done / faithful enough")

Objective gates, each emitting per-property pass/fail, at **both viewports**. Thresholds are checked-in and **calibrated against the golden corpus**, not pulled from air.

| Gate | Compared how | Example (beanburito) |
|---|---|---|
| Structural | IR/DOM, exact | section count = 11, order + archetype match |
| Typographic | re-measured computed styles, tolerance | hero H2 = Outfit / 80px ±1 / 900 exact / −1.6px ±0.1 |
| Color | palette + per-role, ΔE tolerance | body bg #000, section bg #fff, accent #0063ff |
| Geometric | bbox / height / columns, % tolerance | "Reach new heights" band = 3 cols, ~830px tall |
| Asset/content | set membership, exact | every source image, heading, nav href present |
| Perceptual | per-section SSIM / pixel-diff, threshold | aligned slice ≥ threshold at 1440 **and** 375 |
| Interaction *(Phase 2)* | state-transition re-measure | dropdown opens, mobile menu toggles, accordion expands |

**Definition of done for a template:** every gate green, at both viewports, zero un-waived failures — **static gates AND interaction gates.** Static fidelity is the first milestone, not a lower bar; interactions are a required later phase, never optional.

## Phasing

- **Phase 0** — harden `capture` (per-section depth) + `assets` pipeline + assemble the golden corpus (captures + expected IR + reference screenshots checked in).
- **Phase 1** — Template IR schema + `extract` + parameterized `render` + `align` + static eval gates + fix loop → static fidelity on the corpus.
- **Phase 2** — interaction capture → interaction IR → render → interaction gates → **template "done."**

## Golden corpus

Multiple references checked in so improving one can't silently regress another:

1. **beanburito** — `https://beanburito.github.io/free-intro-session-self-book-in-person/` (already captured; dark, Outfit/Montserrat, 11-section home).
2. **webflow-modern** — `https://pushpress-site-modern.webflow.io/` (to capture; light, Montserrat-900, blue accent).
3. **diversity reference — TBD** (Dan to provide; chosen to stress a different layout/aesthetic).

## Kept vs. replaced in the current repo

- **Kept:** `apps/studio/src/capture.mjs` + `shoot-site.mjs` (extended), `packages/llm` (OpenRouter + cost tracking), `apps/renderer` harness (Astro build/lazy-load mechanism), `packages/schema` discipline, the beanburito capture bundle.
- **Replaced:** hand-authored `templates/*` (deleted) → derived Template IR + parameterized components. `TemplateManifest` → Template IR.
- **New:** `assets`, `align`, `eval`, `fix`, `controller`, Template IR schema, deep-capture additions, golden-corpus harness.

## Open items (resolved during planning/implementation, not architecture)

- Exact numeric thresholds per gate — calibrated against the corpus once capture depth exists.
- Diversity reference URL — pending from Dan.
- Fix-loop iteration budget N and per-gate waiver mechanics.
