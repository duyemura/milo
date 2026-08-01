# Plan 3 (Roadmap) — The Full Editable-Site Stack: C · D · E · F + Template Seed

> **Status:** Roadmap / outline. Each subsystem below becomes its own `brainstorm → spec → plan → subagent-execute` cycle (the same flow A+B used), gated by the fidelity oracle. This doc fixes scope + ordering + the one thing each must prove; it is NOT a bite-sized implementation plan.

**Depends on:** **Plan 2 (A+B)** — the LLM-safe semantic representation, global `brand.json`, and `site.json` manifest. Everything here operates over that substrate. Do not start C/D/E/F until A+B is landed and oracle-green.

**Doctrine:** `packages/clone-engine/DOCTRINE.md`. Governing invariant everywhere: **never regress** — the fidelity oracle (0-px on the un-edited projection) stays the floor; new capabilities are additive.

**The North-Star product outcome (from the vision):** whichever seed produced the site (clone or template), a gym owner / PushPress team member makes natural-language requests, an **LLM agent edits *that one site* through the one shared contract**, the site **evolves**, and its **goals are measured**.

**Scope guardrail (Dan, 2026-08-01):** every edit is **per-site, one site at a time**, driven by that gym's own requests or a per-site optimization the agent proposes *for that site*. "At scale" = the same capability works reliably on *any individual* site (breadth of applicability + reliability), **NOT** batch/fleet-wide mutation. There is **no "edit 1000 sites with one command"** operation — do not build cross-site "apply to all" into C. See `project_agent_editing_scope` memory.

---

## Sequencing (recommended)

```
Plan 2  (A+B: representation + brand doc + manifest)          [foundation]
   │
   ├─► C   Edit operations / agent tools        ◄── the payoff; prove edit-at-scale-without-drift FIRST
   │
   ├─► Template-creation system (2nd seed)       ◄── parallel to C; both only consume A+B
   │
   ├─► D   Page model: types + goals             ◄── after C (edits) exist
   │        │
   │        └─► F   Goal measurement             ◄── needs D's goals to measure
   │
   └─► E   Section/component generation          ◄── needs A+B contract + C patterns
```

C and the template-creation system are the two highest-value next moves — one makes the seeded site *editable*, the other adds the *second way to seed*. D→F is the "manage + measure" loop. E is generation, done last and most carefully.

---

## C — Edit operations / agent tools

**Goal:** the *felt* "easy to edit" experience. Agent-callable operations over the A+B contract that a human requests in natural language (or the agent initiates as an optimization). **Scoped to one site at a time** — no batch/fleet operations (see scope guardrail above).

**Acceptance definition:** an agent reliably makes the correct requested change to an *arbitrary* site — structurally, repeatably, and generally — while the scoped-diff oracle guarantees everything it didn't intend to touch stays pixel-identical, so unsafe edits are *caught, not shipped*. (Per-site; reliability/safety is the axis that decides shippability.)

**Delivers:** a typed set of edit ops, each targeting the `site.json` manifest + `data-*` handles and re-projecting/re-rendering:
- `editCopy(copyKey, text)` — edit a `data-copy` slot (already half-wired via the `content[]` array).
- `setBrand(token, value)` — edit one `brand.json` token → cascade site-wide.
- `attachAsset(alias, file)` / `uploadAsset` — swap/add an image/video by `data-asset` alias.
- `addSection / removeSection / reorderSection` — section-level ops by `data-section` role.
- `addPage(route, type)` — new page (ties into D).

**The ONE thing to prove (the unproven bet):** **edit-at-scale without drift.** Today's proof is only "*un*-edited projection = 0-px." C must demonstrate that a real edit (recolor, swap section, add page) keeps the rest of the site coherent and doesn't break layout. **Prove it with a small vertical slice EARLY** — one edit, end-to-end, staying clean — before counting "easy to edit" as delivered.

**Risk:** medium-high. This is where the product bet lives. The brand cascade + semantic addressing are *designed* to make edits local and safe; C is where that gets demonstrated. Mitigation: every op re-runs a scoped render check (edited region intended-diff; everything else 0-px).

**Depends on:** A+B (manifest + brand doc + `data-*`).

---

## Template-creation system (the second seed)

**Goal:** the "build me a new/better site" path — for gyms with no site, a bad site, or wanting a PushPress-owned design. Seed = a template hydrated from business info (`gym.json`), emitted **into the A+B substrate** so it hands off to the *same* edit machinery as a clone.

**Delivers:** a NEW template-creation system that **adheres to A's canonical patterns** (section-role vocabulary, `BrandTokens`-shaped brand doc, `data-*`, `site.json`). Per the doctrine direction: the existing `@milo/schema` / `apps/renderer` templates are **prior art to borrow or discard, not a constraint** — reuse the good parts (the typed section vocabulary, `tokensToCss`), rebuild the rest to emit the contract.

**The ONE thing to prove:** a template-seeded site and a clone-seeded site are **edited by the identical C operations** — the agent can't tell which seed produced the site.

**Risk:** medium. The contract is grounded in the existing template system (which already produces real sites), so the shape is sound; the work is rebuilding emission to the A+B contract. Not a "can we" risk, a "rebuild cleanly" one.

**Depends on:** A+B (the contract to emit into). Independent of C (can proceed in parallel).

---

## D — Page model: types + goals

**Goal:** pages become first-class, typed, goal-bearing objects.

**Delivers:**
- A **page-type** taxonomy: `pillar`, `user-content` (blog / local / member-spotlight), `landing` / `conversion`, etc.
- A **goal** per page (e.g. "book a consult", "join", "read + subscribe"), attached in the manifest (A reserved `data-page-role` / `data-goal` for exactly this).
- Schema + manifest extension; `addPage` (from C) takes a type.

**The ONE thing to prove:** a page's type + goal are machine-addressable in `site.json` and drive both editing (C respects type conventions) and measurement (F reads the goal).

**Risk:** low-medium. Mostly schema + content-strategy modeling.

**Depends on:** A+B; benefits from C (page ops).

---

## E — Section / component generation

**Goal:** author brand-new sections that **inherit the site's brand + semantic system**, so a generated section is indistinguishable in style from the cloned/seeded ones.

**Delivers:** constrained generation — new sections must conform to A's section-role vocabulary, use B's `var(--brand-*)` tokens, and carry the `data-*` contract. Also the opt-in "promote a captured section to a structured content model" transform (noted in the A+B spec) lives here.

**The ONE thing to prove:** a generated section drops into an existing site and is **on-brand + on-contract** (uses the tokens, matches the vocabulary) — generation *within* the established system, never free-draw.

**Risk:** medium-high — this is the "generation" the doctrine was historically wary of. Guardrail: generation is **bounded by** the brand doc + section vocabulary + oracle; it extends the system, it doesn't redraw the site. Do this LAST, once A/B/C patterns are proven.

**Depends on:** A+B + C.

---

## F — Goal measurement

**Goal:** close the loop — instrument pages against their D-goals and measure, so the agent can optimize proactively (feeding back into C).

**Delivers:** goal instrumentation on published sites (conversion/interaction tracking), measurement surfaced to the admin side, and the data an agent needs to decide "this page underperforms its goal → propose an edit."

**The ONE thing to prove:** a published page reports progress against its declared goal, and that signal is legible to the agent + admin.

**Risk:** medium — involves the published-site runtime + analytics + likely the admin/measurement surface (cross-team with the admin session).

**Depends on:** D (goals to measure); ties to the admin side.

---

## Cross-cutting notes

- **Ownership seam:** the engine (this session's domain) exposes C/D/E as operations over the A+B contract + typed CLI/library entrypoints; the **admin side** (other session) drives them and owns F's surfacing + the ~2000-site management plane. Keep the A+B contract + typed entrypoints the *only* coupling.
- **Every subsystem keeps the fidelity oracle as its floor.** Edits and generation produce *intended* diffs on the edited region and **0-px everywhere else** — that scoped-diff discipline is the never-regress rule applied to a mutable site.
- **`.mjs` fallback + `mjs-engine-proven` / `ts-engine-at-parity` tags** remain the deep rollback for the engine core throughout.
