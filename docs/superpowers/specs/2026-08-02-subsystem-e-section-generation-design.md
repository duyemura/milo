# Subsystem E — Section / component generation (bounded PoC)

> **Status:** Design + bounded proof-of-concept. Extends Plan 3 (`docs/superpowers/plans/2026-08-01-clone-engine-plan3-roadmap.md`, section "E") over the A+B substrate (`docs/superpowers/specs/2026-08-01-llm-safe-semantic-representation-design.md`). Depends on A+B (brand doc, `data-*` contract, `site.json`) and reuses subsystem C's insertion + verifier machinery unchanged.

**Doctrine (honored here):** generation is **BOUNDED by** the brand doc + the section-role vocabulary + the fidelity oracle. It **extends the system; it never redraws the site.** This is the "generation" the doctrine was historically wary of. The guardrail is that it is **template-bounded**, not free-form.

---

## The ONE thing to prove

A generated section drops into an existing site and is:

1. **On-brand** — its emitted CSS/markup references only the site's brand tokens (`var(--color-*)`, `var(--font-*)`, `var(--space-*)`, `var(--radius-*)`), never raw literals it invented.
2. **On-contract** — it carries the `data-section` / `data-component` / `data-role` / `data-copy` attributes so the same C edit ops (`editCopy`, `styleTweak`, `removeSection`, …) address it.
3. **Renders cleanly** — `astro build` succeeds, and the verifier confirms **every pre-existing section stays 0-px** (generation didn't disturb the rest of the site).

On-brand + on-contract are proven **by construction + assertion**, not by a before/after pixel diff of the new section (a generated section has no "before" crop to diff against — this is exactly the `addSection` situation, where the added section is proven structurally + render-sanity, not pixel-parity).

---

## The bounded design: template library + LLM fills copy

**Not LLM-drawn HTML. A small library of parameterized section TEMPLATES.**

Each template is authored ONCE, by hand, to:
- use the site's brand tokens by construction (`var(--color-primary)`, `var(--font-display)`, `var(--space-lg)`, …),
- carry the full `data-*` contract by construction (`data-section` role on the root, `data-component`, `data-role` on headline/cta/etc., `data-copy` keyed to `content[]` indices — the exact projector shape),
- declare its **copy slots as a Zod schema** — the ONLY thing the LLM is allowed to fill.

`generateSection(site, { role, goal?, brief }, chat, model)`:
1. **Pick the template by `role`** — throw if the role is not in the library. This is the bounded vocabulary: there is no path to a role the library doesn't have, so there is no free-draw.
2. **LLM fills ONLY the copy slots**, schema-constrained via `llmJson(template.slotSchema, …)`. System prompt: *"Fill this section template's copy for a gym website. On-brand voice. Fill ONLY these fields; do not add HTML or styles."* The model returns structured strings — words, never markup.
3. **Render the template** with the filled copy → a component `.astro` in the exact projector shape (`const content=[…]`, `const e=…`, `const html=\`…\``, `<Fragment set:html={html} />`). Brand tokens + `data-*` contract are present because the template author put them there — the LLM cannot remove or corrupt them.
4. **Insert** via the same machinery `addSection` uses: a unique component name, an `import` + `<Comp />` in `index.astro`, and `site.json` `sections[]` / `copy[]` / `elements[]` entries (with the template's `copyKeys` / `elementRoles` / `sectionRole`).
5. **Oracle-verify** (reusing `verify.ts` unchanged): snapshot BEFORE, insert, then `verify` with an `addSection`-style intent (`expectedSectionOrder` = before order + the new section). Assert: build succeeds (render-sanity), the new section is present structurally, and **every pre-existing section reports `outScopePx === 0`**.

### Why on-brand + on-contract is GUARANTEED, not hoped

The guarantee lives in the **template author**, not the model:
- The template string literally contains `var(--color-*)` / `var(--font-*)` / `var(--space-*)` — the model never writes CSS, so it cannot introduce an off-brand literal.
- The template string literally contains `data-section`, `data-role`, `data-copy` — the model never writes markup, so it cannot drop a contract attribute.
- The model's entire surface area is a **flat object of copy strings** validated by a Zod schema. A schema-invalid response is rejected + retried by `llmJson`; a schema-valid response is, by definition, only words in the declared slots.

The oracle then proves the third property (0-px on everything else) empirically, exactly as C's ops do.

---

## The section-template library (v1)

Two templates, chosen to cover the two most common generation asks and to map onto the D page-goal model:

- **CTA band** — `sectionRole: "cta-band"`, fits the `convert` goal. Slots: `eyebrow?`, `headline`, `subcopy`, `buttonLabel`. Emits a headline (`data-role="headline"`), subcopy (`data-role="body-text"`), and a button (`data-role="primary-cta"`) on a `var(--color-primary)` band with `var(--font-display)` heading.
- **Features grid** — `sectionRole: "feature-grid"`, fits the `inform` goal. Slots: `heading`, three `{ title, body }` feature items. Emits a heading + a 3-up grid (`grid-template-columns` with `var(--space-lg)` gap), each item titled (`data-role="headline"`) with body text (`data-role="body-text"`).

Both roles are already in the A+B `SECTION_ROLES` vocabulary (`cta-band`, `feature-grid`), so a generated section is indistinguishable in role-space from a cloned one.

Each template is a pure function `(filled) => RenderedTemplate` returning:
```
{ html, css?, copyKeys, elementRoles, sectionRole, componentBase }
```
- `html` — the template-literal body (projector shape), with `${e(content[i])}` interpolations for the filled copy.
- `content` — the ordered copy array (what `const content=[…]` gets).
- `copyKeys` — `["<Comp>.0", "<Comp>.1", …]` (bound to the new component name at render time).
- `elementRoles` — `[{ role, id }]` for the manifest.
- `sectionRole` — the A+B section role.
- `css?` — an optional per-component style block appended to `global.css`, referencing ONLY brand tokens (kept minimal; layout via brand `--space-*` / `--radius-*`).

---

## What this reuses (unchanged)

- **C's insertion path** — the same `index.astro` import/include insertion + `site.json` `sections[]`/`copy[]`/`elements[]` shape `addSection` establishes (generalized here into a shared `insertGeneratedSection` helper so `generate.ts` doesn't duplicate `ops.ts`'s file surgery). The verifier/apply/ops logic is NOT modified.
- **The verifier** (`verify.ts` + `snapshot.ts`) — unchanged. `generateSection` builds an `addSection`-style `EditIntent` and calls `verify` exactly as the reflow/addSection tests do.
- **`@milo/llm`** — `llmJson` for schema-constrained copy fills; `fakeChat` in tests.

---

## Honest risk note (FLAG for Dan)

This is the **doctrine-sensitive** piece. What this PoC **proves**: bounded generation is real — a new, LLM-copy-filled section lands on-brand + on-contract + oracle-clean, using the established system, with zero disturbance to existing sections.

What is **deliberately NOT attempted** (open, for Dan to decide whether to expand):
- **Free-form / LLM-drawn HTML** — explicitly out of scope. The doctrine's wariness is respected by never letting the model emit markup or CSS.
- **Template library breadth** — only 2 templates (CTA band, features grid). A production library would need the rest of the `SECTION_ROLES` vocabulary (pricing, testimonials, FAQ, coach-grid, …), each hand-authored to the same contract.
- **Layout-fit intelligence** — `role`/`goal` picks the template; there's no "which section best fits *here*" reasoning yet (that's a C-planner concern).
- **Promote-captured-section-to-structured-model** transform (noted in the A+B spec as living in E) — not built here.

The guardrail that makes expansion safe is unchanged at every step: **template-bounded generation + the scoped-diff oracle as the floor.** Grow the library, not the model's drawing freedom.
