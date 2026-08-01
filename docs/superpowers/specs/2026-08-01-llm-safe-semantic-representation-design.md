# A+B — LLM-Safe Semantic Site Representation + Global Brand Document

**Date:** 2026-08-01
**Status:** Design — approved in brainstorming, pending written-spec review
**Engine:** `page-clone-spike/` · Doctrine: `page-clone-spike/DOCTRINE.md`
**Depends on:** `packages/llm` (`llmJson`), existing `page-clone.mjs` + `project-page.mjs`

## Purpose

Make a cloned site **cleanly editable by an LLM agent** — the engine's number-one goal per
the doctrine. This is the first sub-project (A + B) of the six-subsystem decomposition; it
produces the *representation, brand document, and manifest* that edit-ops (C), page
types/goals (D), section generation (E), and goal measurement (F) will all build on.

The clone is the faithful **starting state**. A+B turn that faithful-but-opaque capture into
a faithful-**and-addressable** substrate an agent can locate things in and change safely.

## Non-negotiable invariant (never regress)

Per the doctrine's coding rule: the existing eval floor must keep passing.

- **Capture** stays byte-for-byte unchanged and deterministic. A+B add *nothing* to
  `page-clone.mjs`'s rendered output.
- The **assembled-vs-clone 0-pixel oracle** in `project-page.mjs` must still report 0 drift at
  1440w and 390w for the **un-edited** projection. Labels + manifest + brand tokens are
  metadata and value-preserving rewrites only; they may not move a pixel.
- Every change is eval'd before/after. If drift regresses, we stop and report — we do not ship
  a worse clone.

## Architecture

Pipeline gains one stage; capture and deploy are unchanged.

```
page-clone.mjs      (UNCHANGED) → capture.json                    [deterministic, faithful]
        │
        ▼
label.mjs           NEW: capture.json → labels.json               [LLM annotates; heuristic fallback]
        │
        ▼
project-page.mjs    EXTENDED: capture.json + labels.json →
                      brand.json  +  semantic components (data-role)  +  site.json manifest
                      + oracle re-diff (unchanged gate)
        │
        ▼
build-site.mjs / deploy.mjs   (UNCHANGED orchestration; site.json merged per page)
```

### 1. `label.mjs` — the labeling pass (NEW)

Runs between capture and projection. Reads `capture.json`, emits `labels.json`.

**Input digest** (compact, so a cheap model handles it): top-level sections (tag, id,
heading/copy snippet, has images/forms/buttons); color palette with **usage stats** (canon
color → counts by element role: buttons / backgrounds / text / links); fonts with usage
context; assets with alt-text + placement context (`<img>` in `<header>` ⇒ logo candidate).

**Output** — Zod-validated via `llmJson`:

```jsonc
{
  "site":    { "name": "Speakeasy of Strength", "purpose": "boutique gym landing + locations" },
  "brand":   {
    "colors": [{ "role": "brand-primary", "canon": "236,0,140,1" }, …],   // role → captured color
    "fonts":  [{ "role": "heading", "family": "'Bebas Neue',sans-serif" }, …]
  },
  "sections":[{ "id": 42, "name": "Testimonials", "role": "testimonials" }, …],  // top-level sections
  "elements":[{ "id": 47, "role": "primary-cta" }, { "id": 3, "role": "logo" }, …],
  "assets":  [{ "file": "assets/a3.png", "alias": "logo" }, …]
}
```

**Model:** Milo's configured `DEFAULT_LLM_MODEL` (`gemini-2.5-flash` via OpenRouter),
swappable. Import pattern mirrors `deploy.mjs` importing `packages/publish`.

**Degradation (mandatory):** if `LLM_PROVIDER` is unset, the call fails, or `--no-llm` is
passed, a deterministic **heuristic labeler** emits the *same schema* — usage-stat brand roles
(most-used saturated color on interactive elements → primary; heaviest/largest-text font →
heading) and `Section{i}` names. **The LLM is an enhancement, never a dependency.** The
pipeline always produces a valid semantic site.

### 2. B — Global brand/style document (`brand.json`) + cascade

`project-page.mjs` generates a per-site `brand.json` from `labels.json`:

```json
{ "colors": { "brand-primary": "#EC008C", "brand-secondary": "#730A8D",
              "brand-accent": "#B5DF0D", "ink": "#1D1D1D", "surface": "#FFFFFF" },
  "fonts":  { "heading": "'Bebas Neue',sans-serif", "body": "'Inter',sans-serif" } }
```

- Generated into `:root{ --brand-primary:#EC008C; … }` (the brand-driven successor to today's
  auto-`--magenta-ec008c` tokens.css).
- The projector rewrites CSS: a literal the labeler mapped to a role → `var(--brand-primary)`.
  Literals with **no** role keep their existing per-literal token (raw palette) — nothing lost.
- **Variant handling — derived tokens (decided).** A brand color at multiple opacities/tints
  becomes derived tokens computed from the base: `rgba(236,0,140,0.6)` → `--brand-primary-60`,
  defined as the exact captured value but *documented as a derivation of* `--brand-primary`.
  (Explicit derived tokens over CSS relative-color, for browser compat.) Editing the base
  value is the single-edit cascade; variants are regenerated from it.
- **Result:** editing `brand.json` and regenerating `:root` recolors the whole site from one
  place — "don't change one button at a time," structurally guaranteed.
- **Fidelity:** because each role/variant token's default value **is** the exact captured
  literal, the un-edited render is byte-identical → oracle stays 0.

### 3. A — Semantic representation

All layered **over** the lossless `.pN` class binding, which is never renamed (fidelity lives
there).

1. **Semantic components** — `TestimonialsSection.astro`, `HeroSection.astro`, … named from
   `labels.sections`, each carrying its `role` in frontmatter. Replaces junk `S3Section`.
   Fallback names (`Section{i}`) when unlabeled.
2. **Element roles in the DOM (decided)** — the projector stamps `data-role="primary-cta"` etc.
   on labeled elements, *and* records role→id in the manifest. Agent addresses by role in the
   manifest or the live DOM. Cost is a few bytes/element; pages stay well under MB (we host
   plain HTML — size budget confirmed acceptable).
3. **Asset aliases** — `logo → assets/a3.png` in the manifest so "swap the logo" resolves.
4. **`site.json` manifest** — the agent's map of the whole site and **A's core deliverable**:
   ```jsonc
   { "brand": "brand.json",
     "pages": [{ "route": "/", "component": "index.astro",
       "sections": [{ "name": "Hero", "role": "hero", "file": "HeroSection.astro" }, …],
       "elements": [{ "role": "primary-cta", "id": "p47", "selector": "[data-role=primary-cta]" }, …],
       "assets":   [{ "alias": "logo", "file": "assets/a3.png" }, …] }] }
   ```
   This manifest is the interface C/D/E/F consume.

## Testing / eval

- **Oracle re-diff (existing, is the gate):** un-edited projection vs clone → **must be 0px**
  at 1440w + 390w on every proven site. This is the pass/fail for "A+B didn't cost fidelity."
- **Regression sweep:** re-run projection on all three proven captures (Torrance / Speakeasy /
  Sweatshed) and confirm 0 drift each. Compare against the pre-change baseline; report any
  regression per the doctrine rule.
- **Degradation test:** run projection with `--no-llm`; confirm a valid site + 0 drift (labels
  blander, fidelity identical).
- **Manifest sanity:** every `site.json` role→id resolves to a real element; every asset alias
  resolves to a file on disk.
- **Labeling quality (soft):** spot-check that section names/brand roles are sensible on the
  three sites; this is quality, not a hard gate (fidelity is the hard gate).

## Out of scope (later sub-projects)

Edit operations / agent tools (C), page types + goals (D), new-section generation (E), goal
measurement (F). A+B deliver only the representation + brand doc + manifest they consume.

## Open implementation details (resolve in planning)

- Exact digest size/shape fed to the labeler (token budget vs. labeling accuracy).
- Whether `label.mjs` is standalone or a `project-page.mjs` sub-step (leaning standalone, so
  labels can be inspected/edited before projection).
- Variant-token naming scheme (`-60` opacity suffix vs. tint index) and how `brand.json` edits
  trigger variant regeneration.
