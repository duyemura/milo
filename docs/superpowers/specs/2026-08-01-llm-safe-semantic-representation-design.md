# A+B — LLM-Safe Semantic Site Representation + Global Brand Document

**Date:** 2026-08-01
**Status:** Design settled with Dan (2026-08-01) — proceeding to implementation plan
**Engine:** `packages/clone-engine/` · Doctrine: `packages/clone-engine/DOCTRINE.md`
**Depends on:** `packages/llm` (`llmJson`), existing `page-clone.mjs` + `project-page.mjs`

## Purpose

Make a cloned site **cleanly editable by an LLM agent** — the engine's number-one goal per
the doctrine. This is the first sub-project (A + B) of the six-subsystem decomposition; it
produces the *representation, brand document, and manifest* that edit-ops (C), page
types/goals (D), section generation (E), and goal measurement (F) will all build on.

The clone is the faithful **starting state**. A+B turn that faithful-but-opaque capture into
a faithful-**and-addressable** substrate an agent can locate things in and change safely.

## Non-negotiable invariant (never regress)

Per the doctrine's coding rule: the existing eval floor must keep passing. The guarantee is
**pixel-level (the oracle), not byte-level HTML** — the projection legitimately changes its HTML
bytes (it adds `data-*` attributes, brand tokens, semantic component names); what may never
change is the rendered pixels of the **un-edited** site.

- **Capture** stays behavior-identical and deterministic through the TS port — same `capture.json`
  and the same capture-vs-source screenshot diff, whether run as `.mjs` or its TS port (the parity
  harness gates this). A+B change none of capture's *rendered* output.
- The **assembled-vs-clone 0-pixel oracle** must still report 0 drift at 1440w and 390w for the
  **un-edited** projection. Labels, manifest, `data-*`, and brand tokens are metadata and
  value-preserving rewrites — render-neutral, so pixels don't move even though HTML bytes do.
- Every change is eval'd before/after. If drift regresses, we stop and report — we do not ship
  a worse clone.

## The contract — A's canonical patterns; templates adhere later

**Non-negotiable end goal (Dan, 2026-08-01):** whichever seed produces a site, the end result is
an editable Astro site an agent edits through the **exact same semantic structure.**

**Direction (Dan, 2026-08-01):** the clone engine's design patterns **are the canonical source of
truth.** We will build a *new* template-creation system that **adheres to these patterns —
later.** The existing `@milo/schema` / renderer templates are **not a constraint** and are not a
concern now; borrow their good ideas or discard them. So A defines the contract on its own
LLM-edit-safety merits; the future template seed conforms to A, not the reverse.

"Same semantic structure" = same editable **contract, not identical section internals.** A
section can be represented two ways *in kind*: a *content model* (`hero = {heading, sub?, cta?,
image}`, layout owned by a component) or a *layout transcription* (captured DOM + computed
styles, pixel-faithful — what the clone produces). Forcing identical internals would require the
clone to extract content and **discard its captured layout** — destroying the faithful replica.
Rejected. Instead: emit **one contract**; the section *body* underneath may be a captured
transcription (clone) or, later, a component (template). The agent's edit surface is identical.

**The contract A defines** (owned by A, extensible):

- **Section roles** — a semantic section-role vocabulary used as `data-section`. Seeded from a
  sensible gym-site taxonomy (`hero`, `faq`, `program-cards`, `coach-grid`, `testimonials`,
  `pricing`, `cta-band`, `feature-grid`, `location-map`, `schedule`, `stats-band`, `logo-strip`,
  `media-block`, `content-block`, `contact-form`, `lead-form` — the existing 16-type set is fine
  prior art), but **A owns it**; `unknown` allowed. The clone's labeling maps captured sections
  onto the nearest role.
- **Brand doc** — a canonical brand-token model (colors `primary/accent/surface/text/muted`,
  fonts `display/body`, `space`, `radius` — the existing `BrandTokens` shape is compatible prior
  art we may reuse), owned by A, flattened to `:root` (reuse or reimplement `tokensToCss`). B
  maps the clone's extracted palette onto these canonical slots; extra captured colors stay as
  non-canonical palette tokens (fidelity), but the canonical set is what cascades + what the
  agent edits as "the brand."
- **Addressability** — `site.json` manifest + `data-*` (`data-section`/`data-role`/`data-asset`/
  `data-copy`). Edit ops (C) target this, so "change the hero heading" / "use my brand color"
  are one op regardless of seed.

Practical implications:

- **Scope now = the clone seed only.** The template-creation system is **deferred** and will be
  built to adhere to this contract — explicitly out of this spec.
- A owns the canonical shape; the existing schema is prior art to borrow from, not a dependency
  to conform to.
- Nothing in A's *manifest* contract may assume a captured-DOM origin (don't leak `.pN` capture
  IDs into the manifest, though the clone's CSS binding uses them internally).
- **Source of truth after seeding is the semantic site** — A carries no "re-project from docs"
  affordance.
- *Opt-in later (not default):* a per-section "promote to structured content" transform can lift
  a faithful-captured section into a content model, consciously trading fidelity for full
  restyle. Subsystem E territory.

## Build target: TypeScript in the workspace (not `.mjs`)

**Engine-code decision (Dan, 2026-08-01, cross-session):** the `.mjs` spike scripts stay as spike
history, but **no production surface may run untyped JS.** A+B is the production foundation (the
contract the admin side and C/D/E/F depend on), so it is built in **TypeScript, as typed packages
+ CLI entrypoints in the pnpm workspace** — matching `milo`'s own `packages/*` and the
pushpress-services stack (strict `typescript-eslint`, Vitest), not more `.mjs`.

Implication for this plan: the proven `page-clone.mjs` (capture) and `project-page.mjs`
(projection) are **ported to TypeScript as part of A+B**, gated by the existing oracle so the port
cannot regress fidelity (the `.mjs` output is the reference during the port). New A+B code
(`label`, brand doc, manifest, `data-*`) is written in TS from the start. The admin side consumes
the engine only through the A+B contract + typed CLI entrypoints, and treats clone-seed triggers
as gated on this port landing.

## Rollback (go-back) path for the TS migration

The port must never leave us worse off. Five layers, in place **before** any porting starts:

1. **Freeze, don't rewrite-in-place.** The proven `.mjs` engine stays fully runnable and
   untouched throughout the port. TS is built *alongside* it, not over it. Falling back is always
   possible because the working engine never left.
2. **Git anchor (done):** annotated tag **`mjs-engine-proven`** marks the last known-good
   pre-migration commit. Ultimate go-back = `git checkout mjs-engine-proven`.
3. **Golden baseline (plan step 0):** before porting, snapshot the current `.mjs` outputs for the
   three proven sites (Torrance / Speakeasy / Sweatshed) — `index.html`, `capture.json`, projected
   components, and the recon/oracle screenshots — into a committed `fixtures/golden/`. This is the
   objective regression baseline the TS port must reproduce.
4. **Parity harness (plan step 0):** a check that runs `.mjs` vs TS on the same inputs and asserts
   **byte parity** on emitted HTML/CSS/manifest and **0-px parity** on the oracle screenshots vs
   the goldens. Green = the TS port is safe to advance; red = it regressed → stay on `.mjs`. This
   is what makes "go back" a decision backed by evidence, not a guess.
5. **Flag-selectable engine during migration.** The CLI entrypoint selects engine (`--engine=mjs`
   default until TS reaches parity, then flips). Fallback is a one-flag change, not a code revert;
   the flag is removed only once TS has held parity on all three sites.

This directly serves the never-regress rule below: the eval floor is the automatic tripwire, and
every layer above is a way to step back to the proven engine the moment the tripwire fires.

## Architecture

Every stage is a TS module in the workspace (ported from the named `.mjs`, behavior-identical and
parity-gated); the pipeline gains one new stage (`label`). Capture and deploy keep their behavior.

```
capture      (port of page-clone.mjs; behavior-identical) → capture.json   [deterministic, faithful]
        │
        ▼
label        NEW (TS): capture.json → labels.json                          [LLM annotates; heuristic fallback]
        │
        ▼
project      (port of project-page.mjs, EXTENDED): capture.json + labels.json →
               brand.json  +  semantic components (data-*)  +  site.json manifest
               + oracle re-diff (unchanged gate)
        │
        ▼
build-site / deploy   (ports; orchestration behavior unchanged; site.json merged per page)
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
  "brand":   {                                        // canonical brand slots (A-owned; BrandTokens-compatible)
    "colors": [{ "slot": "primary", "canon": "236,0,140,1" },   // slot ∈ primary|accent|surface|text|muted
               { "slot": "surface", "canon": "255,255,255,1" }, …],
    "fonts":  [{ "slot": "display", "family": "'Bebas Neue',sans-serif" },   // slot ∈ display|body
               { "slot": "body", "family": "'Inter',sans-serif" }]
  },
  "sections":[{ "id": 42, "name": "Testimonials", "role": "testimonials" }, …],  // role ∈ A's section vocabulary | "unknown"
  "elements":[{ "id": 47, "role": "primary-cta" }, { "id": 3, "role": "logo" }, …],
  "assets":  [{ "file": "assets/a3.png", "alias": "logo" }, …]
}
```

**Model:** Milo's configured `DEFAULT_LLM_MODEL` (`gemini-2.5-flash` via OpenRouter),
swappable. In TS this is a normal workspace import of `packages/llm` (`llmJson`) — no `.mjs`
cross-import hack.

**Degradation (mandatory):** if `LLM_PROVIDER` is unset, the call fails, or `--no-llm` is
passed, a deterministic **heuristic labeler** emits the *same schema* — usage-stat brand roles
(most-used saturated color on interactive elements → primary; heaviest/largest-text font →
heading) and `Section{i}` names. **The LLM is an enhancement, never a dependency.** The
pipeline always produces a valid semantic site.

### 2. B — Global brand/style document (`brand.json`) + cascade

`project-page.mjs` generates a per-site `brand.json` in **A's canonical brand-token shape**
(the existing `BrandTokens` in `packages/schema/src/brand-tokens.ts` is compatible prior art we
may reuse) from `labels.json`:

```json
{ "colors": { "primary": "#EC008C", "accent": "#B5DF0D",
              "surface": "#FFFFFF", "text": "#1D1D1D", "muted": "#8A8A8A" },
  "fonts":  { "display": "'Bebas Neue',sans-serif", "body": "'Inter',sans-serif" },
  "space":  { "sm": "…", "md": "…", "lg": "…" },
  "radius": { "button": "…", "card": "…" } }
```

- Flattened to `:root{ --color-primary:#EC008C; … }` via a `tokensToCss`-style flattener (reuse
  the existing helper or reimplement) — canonical token names, replacing the clone's ad-hoc
  `--magenta-ec008c` tokens.
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

**Business-context documents (ICP, location, GMB, brand kit) are explicitly out of scope.** The
clone seed reads **zero** external business docs today (verified: the engine reads only its own
derived `capture.json` / link map / screenshots) — and it must stay that way. "Documents build
the site" is a *generation* architecture that discards the DOM; it is why the docs-first approach
cloned poorly, and it is the exact trap the clone doctrine avoids. When context docs return later,
they are **editing context for the agent** (inform *what* to change) — **never a source of truth
for layout.** Deferred without cost to the clone.

## Open implementation details (resolve in planning)

- Exact digest size/shape fed to the labeler (token budget vs. labeling accuracy).
- Whether `label.mjs` is standalone or a `project-page.mjs` sub-step (leaning standalone, so
  labels can be inspected/edited before projection).
- Variant-token naming scheme (`-60` opacity suffix vs. tint index) and how `brand.json` edits
  trigger variant regeneration.
