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

## Two seeds, one substrate

There are two ways to produce the starting state, both valid, chosen by the gym's situation:

1. **Clone my site (page-clone path)** — for a gym with a site it likes. Seed = a faithful
   replica of their brand. (This engine.)
2. **Build me a better/new site (template path, Milo v2)** — for a gym with no site, a bad
   site, or one wanting a PushPress-owned design. Seed = a template hydrated from `gym.json`.

**Non-negotiable end goal (Dan, 2026-08-01):** whichever seed produced the site, the end result
is an editable Astro site an agent edits through the **exact same semantic structure.**

"Same semantic structure" = the **same editable *contract*, not the same section internals.**
The two seeds represent a section differently in kind — the template seed uses `@milo/schema`
*content* sections (layout owned by the template component); the clone seed uses *layout
transcription* (captured DOM + computed styles, pixel-faithful). Forcing identical internals
would make the clone extract content and discard the captured layout — destroying fidelity.
Rejected. Instead: **both seeds emit the same contract; the section body underneath may be a
template component or a faithful capture.** The agent's edit surface is identical either way.

**Direction (Dan, 2026-08-01): the clone engine's design patterns ARE the canonical source of
truth.** We will build a *new* template-creation system that **adheres to these patterns —
later.** The existing `@milo/schema` / renderer templates are **not a constraint** and not a
concern now; borrow their good ideas or discard them. A defines the contract on its own
LLM-edit-safety merits; the future template seed conforms to A, not the reverse.

The contract A owns = a **section-role vocabulary** (`data-section`; seeded from a sensible
gym-site taxonomy — the existing 16-type set is fine prior art — but A owns and extends it) + a
**brand-token doc** (`BrandTokens` shape is compatible prior art we may reuse) + the
**addressability layer** (`site.json` manifest + `data-*` + copy keys). C/D/E/F operate over this
one contract. **Scope now = the clone seed only**; the template-creation system is deferred.
**Ownership: this session owns website building/coding — the template-generation code is ours to
reuse or discard in service of this non-negotiable end goal.**

**Source of truth after the seed phase = the semantic site itself.** The agent edits it and it
evolves; there is no re-projection from documents. (This resolves the prior cross-system
conflict: the template path's old "docs are truth, site is a re-runnable deterministic
projection" model is dropped — it is incompatible with "the site evolves via agent edits." Seed
once, then evolve.)

## Build rule: TypeScript in the workspace, not `.mjs`

The `.mjs` spike scripts here stay as spike history, but **no production surface may run untyped
JS** (Dan, 2026-08-01, cross-session). The engine is ported to **TypeScript — typed packages +
CLI entrypoints in the pnpm workspace**, matching `milo`'s `packages/*` and the pushpress-services
stack (strict `typescript-eslint`, Vitest). The port is gated by the fidelity oracle so it can't
regress. The admin side depends on engines **only** through the A+B contract + typed CLI
entrypoints.

## Coding rule: never regress — continually eval

The engine is already a very strong page-clone system. **We do not go backwards on eval or
results.** Any change to website/HTML-adjusting code (capture, projection, tokenization,
assembly, anything that touches the rendered output) must be **continually evaluated to
confirm it makes results better, not worse.**

- The existing gates are the floor, not the ceiling: the **capture screenshot diff vs source**
  and the **assembled-vs-clone 0-pixel oracle** must keep passing. A change that makes them
  worse is rejected, not shipped.
- Before and after any such change, run the eval (re-diff the affected pages) and compare.
  **If results get worse, stop and say so** — surface the regression explicitly rather than
  papering over it.
- New capabilities must be additive: they may not degrade fidelity, self-containment, or the
  lossless-projection guarantee for the un-edited site.

This rule applies to *every* engineer/agent touching this code, on *every* change.

## Design principle: semantic DOM attributes for agent precision

Anywhere a DOM attribute can make the agent's editing more precise, correct, and safe, **stamp
it.** Semantic `data-*` attributes (element role, section role, owning component, asset alias,
copy key, …) are render-neutral — they move no pixel, so the eval floor is untouched — and
cheap on plain-HTML hosting. They let the agent address exactly the right thing in the live
DOM *and* know which source file owns it. Prefer explicit inline semantics over forcing the
agent to infer structure. Mirror the same semantics in the site manifest.

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
