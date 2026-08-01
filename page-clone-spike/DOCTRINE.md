# Creation Engine Doctrine

The north-star rules for the clone/creation engine. Read this before changing the engine.

## The rule

**The engine's output is primarily LLM-edited. Its number-one design goal is a clean,
semantic site that is safe and accessible for an LLM agent to edit.**

Edits are triggered either by a human request ("make the buttons blue", "change the hours")
or by the agent's own optimization decisions (it notices something worth improving). Either
way, the *editor* is an LLM agent; the *requester* is a gym owner or a PushPress team member.

Design for **agent addressability and edit-safety**, not human IDE legibility:

- The agent must reliably **locate** the right thing to change from a vague request.
- The agent must **change** it without breaking the rest of the page.

## The lifecycle: clone is the seed, not the deliverable

A website build always starts from *something* — a template, a competitor, a blank page —
and then evolves. **Cloning just makes the starting state faithful instead of generic.**
Everything after the clone is evolution, driven by the agent.

This reframes the engine's old guarantee. The 0-pixel-diff oracle is **not** the product
guarantee — it is only the **capture guarantee**: the clone *starts* faithful to the source.
The moment the agent edits, drift is the point. Fidelity is the starting state, never the
end goal.

## Scope decomposition

What "LLM-editable site" requires is six subsystems, not one feature. Each gets its own
spec → plan → build cycle.

| # | Subsystem | What it is |
|---|-----------|------------|
| **A** | **Semantic representation** | The clean, addressable output shape: semantic component/section names, addressable assets, stable IDs — the substrate everything else edits. |
| **B** | **Global brand & style document** | One brand/style settings doc that cascades site-wide. "Change the brand color" edits one place, not 200 buttons. Tokens become roles (`--brand-primary`, `--heading-font`). |
| **C** | **Edit operations (agent tools)** | The concrete verbs: edit copy, set brand/style, attach/upload asset, add/remove/adjust section, add page. Each a well-defined op on A+B. |
| **D** | **Page model: types + goals** | Pages have a *type* (pillar, user-content/blog/local/spotlight, landing/conversion) and a measurable *goal*. |
| **E** | **Section/component generation** | Author brand-new sections that inherit the site's brand + semantic system so they match. |
| **F** | **Goal measurement** | Instrument pages against their goals; measure. |

**A + B are the foundation.** C, D, E, and F all edit or extend the representation that A+B
define — there is no clean way to build "remove a section" or "add a page that matches the
brand" until the site *has* a semantic, brand-driven representation to operate on.

**First sub-project: A + B** — "the LLM-safe semantic site representation, driven by a global
brand/style document." It is the correctly-reframed evolution of the engine's original
"editable polish" goal (semantic token names + editable markup), and it unblocks C/D/E/F.

## Status

- 2026-08-01 — Doctrine established (Dan). Engine proven as a faithful multi-page clone
  across three builders (Webflow, Elementor/WP, Squarespace); see `milo_page_clone_spike`
  memory. Designing A+B next.
