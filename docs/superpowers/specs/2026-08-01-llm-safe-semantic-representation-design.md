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

## Seed-agnostic constraint — the shared editable contract

**Non-negotiable end goal (Dan, 2026-08-01):** whichever seed produces a site — clone, or
template hydrated from business info — the end result is an editable Astro site that an agent
edits through the **exact same semantic structure.**

The critical distinction: "same semantic structure" means the **same editable contract, not the
same section internals.** The two seeds represent sections differently *in kind* — the template
seed uses `@milo/schema` *content* sections (`hero = {heading, sub?, cta?, image}`, layout owned
by the template component); the clone seed uses *layout transcription* (captured DOM + computed
styles, pixel-faithful). Forcing identical internals (Option 1) would require the clone to
extract content and **discard the captured layout** — destroying the faithful replica and
violating the clone doctrine. Rejected. Instead (**Option 2, decided**): both seeds emit the
same **contract**; the section *body* underneath may be a template component *or* a faithful
capture. The agent's edit surface is identical either way.

The shared contract = `@milo/schema` as the canonical vocabulary + the addressability layer:

- **Section roles** — `data-section` uses `@milo/schema`'s closed 16-type vocabulary
  (`hero`, `faq`, `program-cards`, `coach-grid`, `testimonials`, `pricing`, `cta-band`,
  `feature-grid`, `location-map`, `schedule`, `stats-band`, `logo-strip`, `media-block`,
  `content-block`, `contact-form`, `lead-form`). The clone's labeling maps captured sections
  onto this vocabulary (nearest role; `unknown` allowed). The template already emits it.
- **Brand doc** — reconciled to `BrandTokens` (`packages/schema/src/brand-tokens.ts`):
  colors `primary/accent/surface/text/muted`, fonts `display/body`, `space`, `radius`, rendered
  by the existing `tokensToCss`. B on the clone side maps its extracted palette onto these
  canonical slots; extra captured colors are preserved as non-canonical palette tokens (fidelity)
  but the canonical five are what cascade + what the agent edits as "the brand."
- **Addressability** — `site.json` manifest + `data-*` (`data-section`/`data-role`/`data-asset`/
  `data-copy`) are identical across seeds. Edit operations (C) target this contract, so
  "change the hero heading" / "use my brand color" run the **same op on either seed.**

Practical implications:

- Reuse `@milo/schema` and `tokensToCss` as the canonical contract — do **not** define a
  parallel shape. The clone conforms to the schema; the schema is extended only if a real
  clone need can't be expressed.
- Nothing in A's *manifest* contract may assume a captured-DOM origin (don't leak `.pN` capture
  IDs into the manifest, though the clone's CSS binding uses them internally).
- Build/prove A+B on the clone seed first (higher-fidelity, harder case). Rebuilding the template
  path to emit the full contract (`data-*` + manifest; it already emits schema sections + brand
  tokens) is **downstream, not in this spec** — but the contract is defined so it drops in.
- **Source of truth after seeding is the semantic site** — A carries no "re-project from docs"
  affordance.
- *Opt-in later (not default):* a per-section "promote to structured content" transform can lift
  a faithful-captured section into a `@milo/schema` content section, consciously trading fidelity
  for full restyle. Subsystem E territory.

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
  "brand":   {                                        // slots = @milo/schema BrandTokens
    "colors": [{ "slot": "primary", "canon": "236,0,140,1" },   // slot ∈ primary|accent|surface|text|muted
               { "slot": "surface", "canon": "255,255,255,1" }, …],
    "fonts":  [{ "slot": "display", "family": "'Bebas Neue',sans-serif" },   // slot ∈ display|body
               { "slot": "body", "family": "'Inter',sans-serif" }]
  },
  "sections":[{ "id": 42, "name": "Testimonials", "role": "testimonials" }, …],  // role ∈ schema's 16 types | "unknown"
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

`project-page.mjs` generates a per-site `brand.json` in the **canonical `BrandTokens` shape**
(`packages/schema/src/brand-tokens.ts`) from `labels.json` — same shape the template seed's
`docs.brand` already uses, so `tokensToCss` renders both:

```json
{ "colors": { "primary": "#EC008C", "accent": "#B5DF0D",
              "surface": "#FFFFFF", "text": "#1D1D1D", "muted": "#8A8A8A" },
  "fonts":  { "display": "'Bebas Neue',sans-serif", "body": "'Inter',sans-serif" },
  "space":  { "sm": "…", "md": "…", "lg": "…" },
  "radius": { "button": "…", "card": "…" } }
```

- Rendered via the existing **`tokensToCss`** into `:root{ --color-primary:#EC008C; … }` (the
  canonical token names, shared with the template seed — replaces the clone's ad-hoc
  `--magenta-ec008c` tokens).
- The projector rewrites CSS: a literal the labeler mapped to a canonical slot →
  `var(--color-primary)`. Captured colors **outside** the five canonical slots keep a
  per-literal palette token (raw palette) so nothing is lost — but the canonical five are what
  cascade and what the agent edits as "the brand." Space/radius default from captured values
  when not confidently inferable.
- **Variant handling — derived tokens (decided).** A brand color at multiple opacities/tints
  becomes derived tokens computed from the base: `rgba(236,0,140,0.6)` → `--color-primary-60`,
  defined as the exact captured value but *documented as a derivation of* `--color-primary`.
  (Explicit derived tokens over CSS relative-color, for browser compat.) Editing the base
  value is the single-edit cascade; variants regenerate from it.
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
2. **Semantic DOM attributes (decided — use them everywhere they help).** Guiding principle:
   *anywhere a DOM attribute makes the agent's editing more precise, correct, and safe, stamp
   it.* Attributes are render-neutral (they change no pixel, so the oracle stays 0) and cheap
   (a few bytes/element; pages stay well under MB on plain-HTML hosting). The full set:
   - `data-role="primary-cta"` — semantic **element** role on labeled elements (CTA, logo,
     headline, nav, …). The agent targets `[data-role=primary-cta]` directly.
   - `data-section="testimonials"` — section **role** on each section wrapper, so the agent
     can find a section's boundary in the live DOM, matching `site.json`.
   - `data-component="TestimonialsSection"` — the **owning component file** on the wrapper, so
     an agent that finds an element in rendered HTML knows *which `.astro` file to edit*.
   - `data-asset="logo"` — the **asset alias** on `<img>`/`<video>`/backgrounds, so "swap the
     logo" is addressable at the element (mirrors the asset-alias map).
   - `data-copy="hero.headline"` — a stable **copy key** on text-bearing elements, tying the
     rendered text back to its entry in the component's editable `content[]` array, so a copy
     edit resolves to an exact array slot rather than a fuzzy string match.
   - *(Forward-compat, populated by later subsystems, reserved now:)* `data-page-role` /
     `data-goal` at page level for D.

   Every attribute is also mirrored in `site.json` — the DOM carries the semantics inline for
   in-place work; the manifest carries them as a queryable index. Attributes are additive and
   value-preserving; they never gate below the 0-px oracle.
3. **Asset aliases** — `logo → assets/a3.png` in the manifest (and `data-asset` in the DOM) so
   "swap the logo" resolves both ways.
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
