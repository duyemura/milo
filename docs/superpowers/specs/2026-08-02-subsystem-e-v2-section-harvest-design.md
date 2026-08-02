# Subsystem E-v2 — Adaptive Section-Template Library by Harvest

**Date:** 2026-08-02
**Status:** Design — approved by product owner in brainstorming, pending written-spec review
**Engine:** `@milo/clone-engine` (`packages/clone-engine`)
**Extends:** E-v1 (`docs/superpowers/specs/2026-08-02-subsystem-e-section-generation-design.md`) — the bounded, hand-authored template PoC (`src/edit/templates.ts` + `generate.ts`)
**Depends on:** Plan 2 substrate (`site.json`, `brand.json`, `data-*`, projected Astro artifact); the brand tokenizer (`src/brand.ts` + `src/project.ts`); the capture path (`src/capture.ts`); the section-role vocabulary (`src/labels.ts` / `SECTION_ROLES` in `src/types.ts`); the pixel oracle (`src/pixel.ts`) and per-section verifier (`src/edit/verify.ts`)
**Doctrine:** `packages/clone-engine/DOCTRINE.md`; never-regress rule (`feedback_never_regress_html_eval` memory); per-site scope guardrail (`project_agent_editing_scope` memory)
**Roadmap:** Plan 3, section "E" (`docs/superpowers/plans/2026-08-01-clone-engine-plan3-roadmap.md`)

---

## Purpose

E-v1 proved bounded section generation is real: a new, LLM-copy-filled section lands **on-brand + on-contract + oracle-clean**, using the established system, with zero disturbance to existing sections. But E-v1's library is **two hand-authored templates** (`cta-band`, `feature-grid`). A production library needs the rest of the vocabulary — and hand-authoring each one is slow and biased toward the author's imagination, not toward what real boutique-gym sites actually use.

E-v2 **grows the library by harvesting sections from real gym websites** and canonicalizing them into adaptive, on-brand-by-construction templates — the same `templates.ts` / `generate.ts` shape E-v1 established. The library grows by **structural novelty, not by site count**: scanning 30 sites should yield a small number of *distinct* archetypes, not 200 near-duplicates.

**One-line framing:** harvest sections → tokenize → keep only the ones the tokenizer can make brand-agnostic → dedup by structural fingerprint → each surviving archetype becomes an E-v1-compatible template.

### Core principle: structure is industry-agnostic

**We harvest the conversion-section *skeleton*, not the *industry*.** The structural archetypes of conversion websites — hero, pricing table, feature grid, testimonials, FAQ, CTA band, team/coach grid, schedule/booking grid — are the **same across industries**: gym, SaaS, dentist, restaurant, D2C. A pricing table is a pricing table whether it sells memberships or software seats; a team grid is a team grid whether the faces are coaches or dentists. Because harvesting **tokenizes away colors/fonts and keeps only the brand-stripped slot skeleton**, the *source industry is irrelevant by construction* — nothing gym-specific survives into the template. **Domain-specificity enters only at GENERATION time** (filling copy + brand slots for a particular gym), never at harvest time.

This principle has three consequences, all favorable:

1. **It resolves the ToS/competitor concern.** We can scan any well-built conversion site, because we keep brand-stripped *structure* (a generic layout skeleton), not copy or assets — there is no reproduction of any source site to worry about (see the Legal/ToS row in [Risks](#risks)).
2. **It improves the library.** A broader, higher-quality, more varied source pool yields better archetypes than 30 gym sites alone would. In practice E-v2 draws that pool from **local B2C service businesses** (dentists, barbershops, cafés, auto shops, …) — the closest structural analog to a gym site (local, conversion-driven, book/call/visit), so the archetypes map ~1:1 with a much deeper example pool and no competitor optics (see the [corpus](#the-30-site-calibration-scan-local-b2c-service-businesses)).
3. **It keeps the library small and universal.** This ties to the standing thesis: the web **converges on a few dozen conversion patterns.** Harvesting across industries converges *faster* on that shared set — the target library is **~30-50 archetypes total**, universal across verticals, gym-specialized only at fill-time.

The domain-shaped roles gyms need are not special-cased — they generalize: a **class-schedule** is any calendar/booking grid, a **coach-grid** is any team page, **membership-tiers** are any pricing table. Harvesting those roles from strong non-gym sources is not a compromise; it is a *stronger* sample of the same structure.

### What E-v2 is NOT

- **Not free-form / LLM-drawn HTML.** The doctrine's wariness of generation is respected exactly as in E-v1: the model never emits markup or CSS. Harvesting produces *hand-verified, tokenized templates*; the LLM's only runtime job stays "fill the copy slots."
- **Not themed sets.** Explicitly out of scope per the owner (see [Out of Scope](#out-of-scope)). Sections that only cohere in their own bespoke look are **rejected**, not preserved as a themed variant.
- **Not a cross-site edit operation.** Harvesting *reads* many sites to build a shared library; it never *mutates* many sites. Per-site editing (subsystem C) is unchanged and remains strictly one-site-at-a-time.

---

## The ONE thing to prove

> **A section harvested from site A, after tokenization, re-renders coherently under site B's brand tokens — proven by the swap-brand oracle — and its structural fingerprint deduplicates it against the growing library so the library grows only on genuine structural novelty.**

Concretely, the calibration scan must demonstrate:

1. **Adaptivity is measurable and real.** For each admitted archetype, re-rendering it under a *different* scanned site's `brand.json` produces a coherent section (render-sanity clean, no broken layout, no off-brand literal leaking through) — the swap-brand oracle passes. This is the empirical proof that "brand identity was absorbed by the tokenizer," not merely asserted.
2. **The fingerprint controls variation explosion.** 30 sites × ~6-10 sections ≈ 200-300 harvested sections collapse to a **small** set of archetypes (target: tens, not hundreds), and the popularity counts are legible (each archetype records how many scanned sites use it).

If either fails — if tokenized sections don't survive a brand swap, or if the fingerprint fails to collapse near-duplicates — the harvest approach is not yet proven and the library stays hand-authored.

---

## The adaptive / reject classifier — the tokenizer IS the classifier

E-v2 does not invent a new "is this section adaptive?" model. It **reuses the existing brand tokenizer** (`brand.ts` + `project.ts`) as the classifier. The insight the owner approved:

> A section is adaptive **exactly when the tokenizer can absorb its visual identity.** If replacing literal colors/fonts with `var(--color-*)` / `var(--font-*)` leaves little residual bespoke styling, the section's "look" *lived in the brand tokens* — so it will look native under any brand. If heavy bespoke styling survives tokenization, the section's look is intrinsic to itself and it will only ever cohere in its own skin.

### The pipeline per harvested section

1. **Tokenize.** Run the section's captured styles through the same tokenizer the clone engine already uses: literal colors → `var(--color-<slot>)` / `var(--color-<slot>-<NN>)`, literal fonts → `var(--font-<slot>)`, and (where the section uses them) spacing/radius mapped to `--space-*` / `--radius-*`. This is byte-preserving for the source site (the tokenizer's existing invariant) — the same literal resolves to the same bytes.

2. **Measure the residual.** After tokenization, compute the **residual bespoke styling** = the styling that did NOT reduce to a brand token: raw color/gradient literals that don't map to any slot, background images / clip-paths / masks / bespoke box-shadows, non-token magic-number geometry, one-off pseudo-element art, filters, blend modes. (Definition of the residual metric is in [Calibration](#the-30-site-calibration-scan-local-b2c-service-businesses) — it is set empirically, not by a guessed constant.)

3. **Classify.**
   - **Adaptive (keep)** — residual is below the calibrated threshold. The tokenizer absorbed most of the identity; the section is a candidate archetype.
   - **Reject** — residual is above the threshold. Heavy bespoke styling survived (background art, clip-paths, one-off treatments) → the section coheres only in its own look → **not admitted** to the interchangeable library. (Themed handling is out of scope; such sections are simply dropped for v2.)

4. **Prove adaptivity with the swap-brand oracle (the gate, not a heuristic).** A low residual is *necessary but not sufficient* — a section could tokenize cleanly and still break geometrically under a different palette (e.g. a color the layout secretly depended on for contrast). So every keep-candidate is **proven**, not assumed:
   - Re-render the tokenized section under **≥2 other scanned sites' `brand.json`** (deliberately different palettes — light-on-dark vs dark-on-light, serif vs sans display).
   - Run render-sanity (from `verify.ts`: builds, no overlapping section boxes beyond tolerance) + an **off-brand-literal scan** (assert the emitted CSS references only `var(--*)` brand tokens, never a raw literal it should have tokenized).
   - **Pass = admitted. Fail = rejected**, even if its residual was under threshold. The oracle is the fidelity floor here exactly as it is everywhere else in the engine.

### Why reuse the tokenizer instead of a new classifier

The tokenizer is already the mechanism that makes a *cloned* site editable and recolorable; "adaptive" is definitionally "recolorable by this exact tokenizer." Building a separate ML/heuristic adaptivity classifier would risk disagreeing with the tokenizer that will actually render the template downstream. Using the tokenizer as the classifier makes the classification and the runtime behavior the same code path — no drift.

---

## The structural fingerprint — the anti-variation-explosion mechanism

Two sections that look different but are *structurally the same thing* must collapse to **one** template. The fingerprint is what decides "same template or new template."

### Fingerprint definition

```
fingerprint = hash(
  role,               // from SECTION_ROLES (e.g. "cta-band", "feature-grid", "pricing")
  slotTree,           // ordered semantic slots + CARDINALITY collapsed to 1..N (not exact count)
  layoutPrimitive     // one of: stack | grid | split | overlay | alternating
)
```

- **`role`** — the A+B section role from `SECTION_ROLES`. A harvested section is labeled with the existing labeler before fingerprinting.
- **`slotTree`** — the ordered tree of *semantic slots* the section exposes (headline, subcopy, cta, feature-item{title,body}, media, …), with repetition collapsed to a **cardinality class**: `1` (exactly one), `N` (a repeating group of ≥2). A grid of 3 cards and a grid of 6 cards have the **same** slot tree (`heading:1, card:N{title:1, body:1}`).
- **`layoutPrimitive`** — the coarse arrangement: `stack` (vertical flow), `grid` (repeating N-up), `split` (2-column content/media), `overlay` (content layered over media/background), `alternating` (zig-zag rows). This is derived from the tokenized layout, not from pixel positions.

### What the fingerprint DELIBERATELY EXCLUDES

These are all **knobs**, never part of the identity of a template:

- media **type** (image vs video vs none)
- alignment (left / center / right)
- density / spacing scale
- color, font (already tokenized away)
- exact item count (collapsed to 1..N)
- copy text, image bytes
- exact geometry / magic numbers

Two sections with the same fingerprint are, by definition, **the same template**.

### The rule (the owner's #1 concern — stated prominently)

> **A NEW template requires a different CONTENT MODEL (what the gym owner fills in) or a different LAYOUT PRIMITIVE. Everything visual is a KNOB, not a template.**

The test to apply for every harvested section: **"Does this change what the owner *provides*, or only *how it looks*?"**

- Changes what the owner provides → different content model → **candidate new template**.
- Changes only how it looks → **same template, expressed via a knob**.

#### Worked examples (the exact cases the owner raised)

| Two sections | Same or new template? | Why |
|---|---|---|
| Video-background hero vs image-background hero | **Same template** | `media.type` is a knob. Owner still provides: headline, subcopy, CTA, one background asset. Slot tree + layout primitive (`overlay`) identical. |
| Left-aligned CTA vs right-aligned CTA | **Same template** | `align` is a knob. Same slots, same primitive. Nothing the owner fills in changes. |
| Hero with a single CTA button vs hero with an inline lead-capture FORM | **NEW template** | Different content model. The form hero asks the owner for *form fields / a submission target*, not a button label — a genuinely different set of things to fill in. Slot tree differs (`primary-cta:1` vs `form:1{field:N}`). |

The knob-vs-template line is the whole game: knobs let one template cover a *family* of looks; the fingerprint guarantees we only mint a new library entry when the owner's fill-in contract actually changes.

### The knob model

Each admitted archetype exposes a small, **bounded** knob set (not free-form styling):

- `media.type` — `image` | `video` | `none`
- `media.position` — `left` | `right` | `background` (constrained by layout primitive)
- `align` — `left` | `center` | `right`
- `density` — `compact` | `default` | `roomy` (maps to `--space-*` scale)
- `itemCount` — integer within the archetype's supported range (for `N`-cardinality slots)

Knobs are enumerated per archetype at harvest time (only the knobs that archetype actually supports). Knobs are the mechanism that covers a family with **one** template instead of many entries — and they never introduce a raw literal (every knob resolves to a brand token or a bounded enum). Knob *defaults* are seeded from the modal value across the harvested instances of that fingerprint.

---

## The harvest pipeline

```
scan            → capture each site  (existing src/capture.ts, unchanged)
  ↓
segment + label → partition into sections, assign SECTION_ROLES (existing labeler)
  ↓
tokenize        → brand-tokenize each section (existing brand.ts + project.ts)
  ↓
classify        → adaptive (keep) / reject, by residual + swap-brand oracle
  ↓
fingerprint     → role + slotTree + layoutPrimitive
  ↓
dedup           → group by fingerprint into ARCHETYPES; record popularity (# sites)
  ↓
canonicalize    → pick a representative per archetype; extract slots + knobs
  ↓
emit            → an E-v1-compatible template (templates.ts shape) per archetype:
                    slotSchema (Zod) + render() → RenderedTemplate
                    { html (projector shape), content[], copyKeys,
                      elementRoles, sectionRole, css (brand tokens only) }
                  + the data-* contract, byte-for-byte in E-v1's shape
```

### Stage notes

- **scan / segment / label / tokenize** reuse existing machinery unchanged (see [Reuse](#what-this-reuses-unchanged)). Harvesting is a *new consumer* of these, not a modification to them.
- **classify** is [the tokenizer-as-classifier + swap-brand oracle](#the-adaptive--reject-classifier--the-tokenizer-is-the-classifier) above.
- **dedup** groups harvested instances by fingerprint. Each group = one archetype. **Popularity** = the number of *distinct scanned sites* whose sections landed in that group (site-level, not instance-level, so a site that repeats a pattern doesn't inflate its own vote).
- **canonicalize** selects a representative instance (the one closest to the group's modal slot tree, ties broken by lowest residual), derives the `slotSchema` from its slot tree, and enumerates the knobs the group's members vary over. The representative's tokenized markup becomes the template body.
- **emit** produces exactly the E-v1 `SectionTemplate` shape so `generate.ts` inserts a harvested template identically to a hand-authored one. A harvested template is **indistinguishable at runtime** from an E-v1 template — same `data-*` contract, same projector shape, same insertion + verify path.

### Output artifact

The harvest is an **offline authoring pipeline**, not a runtime path. It emits template *source* (reviewed, committed to `templates.ts` / a `templates/` dir) plus a `harvest-report.json` recording, per candidate: source site, fingerprint, residual score, swap-brand oracle result, popularity, and knob enumeration. The report is the human-gate's evidence (see Governance).

---

## Governance / promotion

The library must grow *carefully* — a bad archetype pollutes every future generation. Four rules:

1. **Promote-by-novelty.** A harvested section whose fingerprint **matches an existing archetype is a VARIANT, not a new template** — it is *not added*; instead it casts a **popularity vote** for the matched archetype (and may contribute a knob value if it varies one). Only a fingerprint with **no** existing match is a promotion candidate.

2. **Human-gate the early additions.** Until clustering is demonstrably trustworthy, **every** first-time archetype promotion is reviewed by a human against the `harvest-report.json` (does the fingerprint make sense? is the swap-brand render actually coherent? is the slot schema right?). The gate relaxes only after the clustering has been validated on the calibration corpus.

3. **Popularity floor (quarantine).** An archetype seen on only **1-2 sites** is likely noise (an idiosyncratic one-off that happened to tokenize cleanly) → **quarantine**, not admit. It stays in the report for review but does not enter the live library until corroborated by more sites or a human override. The exact floor is set from the popularity distribution observed in the calibration scan.

4. **Self-pruning / merge.** The library periodically re-checks: if two archetypes turn out to be **the same shape differing only by a knob** (e.g. a later refinement of the fingerprint or knob model reveals they collapse), they are **merged** — the knob absorbs the difference and one entry is retired. This keeps the library from accreting redundant entries as the fingerprint definition sharpens.

**Invariant across all four:** the library grows on **structural novelty gated by corroboration**, and every admitted template still has to pass the swap-brand oracle. Novelty gets you *considered*; the oracle gets you *admitted*.

---

## The ~30-site calibration scan (local B2C service businesses)

This list is the **calibration corpus** — the input that sets the residual threshold, the popularity floor, and validates that the fingerprint collapses near-duplicates. Per the [structure-is-industry-agnostic principle](#core-principle-structure-is-industry-agnostic), the corpus is **~30 well-built local B2C SERVICE-business websites** — the **closest structural analog to gym sites**. A neighborhood dentist, barbershop, or auto shop is the same *species* as a gym: a local, conversion-driven B2C service whose site runs the identical pattern set — hero + CTA (book / call / visit), services grid, about, testimonials, hours/location, gallery, pricing, contact/booking. Their section archetypes map **~1:1** onto what gym sites need, with **no competitor optics** and a **much deeper pool** of examples than gyms alone.

The corpus draws a balanced cross-section of local-service verticals (~3-5 sites each) and keeps a **handful of real gyms** in the mix so the domain-shaped roles (`schedule`/booking, `coach-grid`/staff grid, `pricing`/membership tiers) are sampled from genuine gym sites too. Load-bearing requirements are **build quality** (independently designed, conversion-driven sites — not page-builder clones), **vertical + geography balance** (large-city / small-city mix), and **archetype coverage** (every intended `SECTION_ROLE` appears in ≥2 sources) — **not** the specific names.

Entries marked **(verify)** are plausible real businesses I could not confirm live from memory alone — a plan step must confirm each URL resolves and is an independently-built service-business site before scanning; substitute a same-vertical/same-tier peer if any 404s or has been rebuilt onto an obvious page-builder template that would skew the corpus.

> **Note on selection bias:** the corpus should skew toward *independent / custom-built* sites, not sites on a single cookie-cutter website product — a cluster of identical vendor-template sites would falsely inflate one fingerprint's popularity. Popularity counts distinct sites, and the human-gate reviews suspicious clusters. All URLs to be confirmed at plan time.

### Gyms / boutique fitness (5) — retained for domain-role coverage

| # | Source | Vertical · City (tier) | URL (verify all) |
|---|---|---|---|
| 1 | Marcelo Garcia Jiu-Jitsu | BJJ gym · New York, NY (large) | marcelogarciajj.com *(verify)* |
| 2 | CrossFit Roots | CrossFit · Boulder, CO (small) | crossfitroots.com *(verify)* |
| 3 | Sol Yoga | Yoga studio · Missoula, MT (small) | solyogamt.com *(verify)* |
| 4 | Club Pilates | Pilates studio · Irvine, CA (large) | clubpilates.com *(verify)* |
| 5 | CrossFit South Brooklyn | CrossFit · Brooklyn, NY (large) | crossfitsouthbrooklyn.com *(verify)* |

### Coffee shops / cafés (3)

| # | Source | City (tier) | URL (verify all) |
|---|---|---|---|
| 6 | Verve Coffee Roasters | Santa Cruz, CA (small) | vervecoffee.com *(verify)* |
| 7 | Ruby Coffee Roasters | Nelsonville, WI (small) | rubycoffeeroasters.com *(verify)* |
| 8 | Gaslight Coffee Roasters | Chicago, IL (large) | gaslightcoffeeroasters.com *(verify)* |

### Salons & barbershops (4)

| # | Source | City (tier) | URL (verify all) |
|---|---|---|---|
| 9 | Fellow Barber | New York, NY (large) | fellowbarber.com *(verify)* |
| 10 | Blind Barber | Los Angeles, CA (large) | blindbarber.com *(verify)* |
| 11 | Rudy's Barbershop | Seattle, WA (large) | rudysbarbershop.com *(verify)* |
| 12 | The Gents Place | Frisco, TX (small) | thegentsplace.com *(verify)* |

### Dentists / med spas (5)

| # | Source | Vertical · City (tier) | URL (verify all) |
|---|---|---|---|
| 13 | Tend | Dental · New York, NY (large) | hellotend.com *(verify)* |
| 14 | Dandy Dental (practice site) | Dental · Denver, CO (large) | *(verify — pick an independent local practice)* |
| 15 | Heyday | Facials / med spa · New York, NY (large) | heydayskincare.com *(verify)* |
| 16 | Ever/Body | Med spa · New York, NY (large) | everbody.com *(verify)* |
| 17 | Skin Laundry | Med spa · Los Angeles, CA (large) | skinlaundry.com *(verify)* |

### Plumbers / HVAC / electricians (4)

| # | Source | Vertical · City (tier) | URL (verify all) |
|---|---|---|---|
| 18 | Roto-Rooter (local franchise page) | Plumbing · Columbus, OH (large) | rotorooter.com *(verify)* |
| 19 | Mister Sparky | Electrician · Tulsa, OK (small) | mistersparky.com *(verify)* |
| 20 | Bell Brothers | HVAC/plumbing · Sacramento, CA (large) | bellbrothers.com *(verify)* |
| 21 | Fox Family Heating & Air | HVAC · Rancho Cordova, CA (small) | foxfamilyhvac.com *(verify)* |

### Restaurants (3)

| # | Source | City (tier) | URL (verify all) |
|---|---|---|---|
| 22 | Sweetgreen | Los Angeles, CA (large) | sweetgreen.com *(verify)* |
| 23 | Zahav | Philadelphia, PA (large) | zahavrestaurant.com *(verify)* |
| 24 | The Bird & The Bear | Bentonville, AR (small) | *(verify — pick an independent local restaurant)* |

### Auto repair / detailing (3)

| # | Source | City (tier) | URL (verify all) |
|---|---|---|---|
| 25 | Christian Brothers Automotive | Houston, TX (large) | cbac.com *(verify)* |
| 26 | Luscious Garage | San Francisco, CA (large) | lusciousgarage.com *(verify)* |
| 27 | Wrench (mobile mechanic) | Kalispell, MT (small) | *(verify — pick an independent local shop)* |

### Pet grooming / boarding & landscaping (3)

| # | Source | Vertical · City (tier) | URL (verify all) |
|---|---|---|---|
| 28 | The Dog Stop | Pet grooming/boarding · Pittsburgh, PA (large) | thedogstop.com *(verify)* |
| 29 | Splash and Dash | Pet grooming · Bozeman, MT (small) | *(verify — pick an independent local groomer)* |
| 30 | FormLA Landscaping | Landscaping · Los Angeles, CA (large) | formla.net *(verify)* |

**Balance summary:** Gyms 5 · Coffee 3 · Salons/barbers 4 · Dental/med-spa 5 · Plumbing/HVAC/electric 4 · Restaurants 3 · Auto 3 · Pet/landscaping 3 (= 30), spanning ~8 verticals with a large-city / small-city mix throughout. Every domain-shaped role gyms need is corroborated across verticals: **booking/schedule** appears in salons, dentists, med spas, and the gym cohort; **staff/team grid** in barbershops, dental practices, and coach grids; **service/pricing tiers** in HVAC, med spas, and membership tables. Specific names are substitutable so long as the **archetype-coverage** (each intended `SECTION_ROLE` in ≥2 sources), **vertical/geography balance**, and **quality/independence** requirements hold. All 30 URLs are **candidates to verify at plan time** — several rows deliberately say "pick an independent local X" where a specific real site was not confirmable from memory.

### Sourcing note — packaged component libraries as a bootstrap, not the primary

Existing landing-page / component libraries (open marketing-site kits, component galleries) are effectively **already-canonicalized conversion sections** and could *bootstrap* the archetype set quickly. But **live-harvest of brand-stripped structure stays PRIMARY**: packaged kits carry licenses, whereas brand-stripped structure derived from live sites does not reproduce any licensed artifact. Treat packaged kits as an optional seed/cross-check for the clustering, never as the shipped source of templates.

---

## Out of scope

- **Themed section sets.** Explicitly excluded by the owner. Sections that survive tokenization only in their own look are **rejected**, never preserved as a "brutalist hero" / "luxe hero" themed variant. E-v2 is **adaptive-only**.
- **Free-form / LLM-drawn HTML.** As in E-v1, the model never emits markup or CSS. Harvesting produces hand-verified tokenized templates; the runtime LLM job stays "fill the copy slots."
- **Runtime harvesting.** The harvest is an **offline authoring pipeline** whose output (reviewed template source) is committed. There is no "clone a competitor's section into my live site on demand" runtime path in v2.
- **Cross-site editing.** Harvesting reads many sites to build one shared library; it never mutates many sites. The per-site edit scope guardrail is untouched.
- **New knob *dimensions* beyond the bounded set.** v2 ships the enumerated knobs (media.type, media.position, align, density, itemCount). New knob dimensions are a deliberate later expansion, gated the same way.

---

## What this reuses (unchanged)

E-v2 is overwhelmingly a **new consumer** of existing machinery, not new engine primitives:

- **`src/capture.ts`** — capture each scanned site. Unchanged.
- **`src/labels.ts` / `SECTION_ROLES`** — segment into sections + assign roles for the fingerprint. Unchanged.
- **`src/brand.ts` + `src/project.ts`** — the brand tokenizer, reused **as the adaptive/reject classifier**. This is the central reuse: "adaptive" is definitionally "what this tokenizer can absorb." Unchanged.
- **`src/pixel.ts` + `src/edit/verify.ts`** — the pixel oracle + render-sanity, reused as the **swap-brand oracle** (render the tokenized section under another site's brand and prove it coheres). The verifier's render-sanity + off-brand-literal checks are the admission gate. Unchanged.
- **E-v1 `src/edit/templates.ts` + `generate.ts`** — the **output target**. Every harvested archetype is emitted in the exact `SectionTemplate` / `RenderedTemplate` shape E-v1 defined (`slotSchema`, `render()`, projector-shape `html`, `content[]`, `copyKeys`, `elementRoles`, `sectionRole`, brand-token-only `css`). A harvested template inserts + verifies via the identical `generate.ts` path — indistinguishable from a hand-authored one at runtime.
- **`@milo/llm` `llmJson`** — unchanged; still the schema-constrained copy-fill at generation time. Harvesting itself is mostly deterministic (tokenize + fingerprint + oracle); any LLM assist during canonicalization (e.g. naming slots) is post-validated against the captured structure exactly as `labels.ts` post-validates the LLM labeler.

**New surface E-v2 adds** (for the follow-on plan, not built here): a harvest orchestrator (scan→classify→fingerprint→dedup→emit), the residual-styling metric, the fingerprint function, the knob enumerator, the canonicalizer, and the `harvest-report.json` schema + human-gate. All of them sit *on top of* the unchanged primitives above.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Threshold is a magic number.** Pick the residual cut wrong and either everything rejects or garbage admits. | High | Threshold is **calibrated on the 30-site scan**, not guessed: plot the residual distribution, pick the cut where the swap-brand oracle stays clean. The oracle — not the threshold — is the actual admission gate, so a mis-set threshold only shifts how many candidates the oracle has to reject. |
| **Fingerprint too coarse** → distinct content models collapse into one template (owner fills in the wrong things). | High | The new-template rule is content-model-first ("does it change what the owner provides?"). The slot tree is part of the fingerprint precisely so a different fill-in contract (button vs form) forks a new template. Validate on the corpus that the known-distinct cases (form-hero vs button-hero) do NOT collapse. |
| **Fingerprint too fine** → variation explosion, the exact failure mode E-v2 exists to prevent. | High | Cardinality collapsed to 1..N; media-type/align/density/color/font/geometry all excluded as knobs. Success metric: 30 sites → tens of archetypes, not hundreds. If it explodes, the fingerprint is over-specified and must drop more dimensions into knobs. |
| **Swap-brand oracle false-positive** — a section renders "coherent" under 2 brands but breaks on a 3rd. | Medium | Swap against ≥2 *deliberately diverse* brands (light/dark, serif/sans); add more swap targets if the corpus reveals brittle archetypes. The oracle can only prove what it tests — treat admitted archetypes as provisional until they survive real generation use. |
| **Corpus selection bias** — a cluster of same-vendor-template sites inflates one fingerprint. | Medium | Skew corpus to independent/custom sites across verticals; swap out any source that has moved to an obvious page-builder template; popularity counts distinct sites, and the human-gate reviews suspicious clusters. Sourcing across ~8 local-service verticals *reduces* this risk (harder to accidentally over-sample one vendor's template across many verticals than within one). |
| **Legal / ToS** of scanning source sites. | Low | Resolved by the [structure-is-industry-agnostic principle](#core-principle-structure-is-industry-agnostic): we harvest brand-stripped **structure** (a generic layout skeleton), never copy or assets, so there is no reproduction of any source site. Owner is comfortable scanning any well-built conversion site. One residual note: keep the guarantee that no source copy/asset is ever carried into a template. |
| **Harvest complexity vs payoff** — the pipeline is more machinery than hand-authoring N templates. | Low-Med | The pipeline is offline authoring tooling, gated by humans early; if it under-delivers, hand-authoring (E-v1) remains the fallback and nothing shipped depends on harvest at runtime. |

---

## Self-review

- **Placeholder scan:** every name + URL in the 30-site corpus is marked **(verify)**, and a few rows deliberately say "pick an independent local X" — they are plausible real local-service businesses researched from memory, not fetched, so each must be confirmed live + independently-built at plan time, with same-vertical/same-tier substitution allowed. The spec explicitly makes the *balance* (vertical × geography) and *archetype coverage* (each role in ≥2 sources) load-bearing, not the specific names. No other placeholders remain — the residual metric, threshold, and popularity floor are all deliberately deferred to empirical calibration (that deferral is the design, not a gap).
- **Internal consistency:** the tokenizer-as-classifier, the swap-brand oracle, and the fingerprint all reduce to *existing* engine invariants (byte-preserving tokenization, the scoped-diff oracle, `SECTION_ROLES`). The structure-is-industry-agnostic principle is the load-bearing justification for the cross-vertical corpus: because harvesting keeps only the brand-stripped skeleton, the source vertical is provably irrelevant, so local-service-business sources yield gym-usable archetypes. The output shape is E-v1's `SectionTemplate` verbatim, so the harvest end-state plugs into the proven `generate.ts` insertion + verify path with no new runtime primitive. The knob model and the fingerprint-excludes list are the same list viewed twice (everything the fingerprint excludes is a knob), which is intentional and consistent.
- **Scope:** themed sets and free-form generation are excluded in three places (Purpose, the classifier's reject branch, Out of Scope) — matching the owner's explicit exclusion. The corpus is B2C local-service businesses (the closest structural analog to gyms), not gyms only and not the earlier SaaS/D2C mix — domain-specificity is deferred to generation time per the principle. Per-site edit scope is untouched; harvesting is read-only across sites and never a fleet mutation. This is a **design spec only** — no engine code; a `brainstorm→plan→execute` cycle follows, and the spec is written to be buildable from (every new surface is named in [Reuse](#what-this-reuses-unchanged)).
- **The one thing to prove** is falsifiable and measured on the calibration corpus (adaptivity survives brand-swap; fingerprint collapses near-duplicates) — if either fails, the approach is disproven and the library stays hand-authored, which is a safe fallback.
