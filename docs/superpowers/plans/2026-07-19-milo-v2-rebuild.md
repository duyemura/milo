# Milo v2 Rebuild Implementation Plan (Overnight Session 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Milo v2 repo with the GymSiteContent contract, the complete "modern" template, a renderer that turns any valid gym.json + template into a static site, and a working CLI `build` — proving the docs→content→template→site spine end to end with fixture data.

**Architecture:** pnpm workspace. `packages/schema` owns the typed contract (Zod). `templates/modern` is a self-contained Astro component library implementing the full component vocabulary. `apps/renderer` is an Astro app that maps a `GymSiteContent` JSON through page archetypes to template components. `apps/cli` wraps build/preview. Everything downstream of the contract is deterministic.

**Tech Stack:** Node 24, pnpm, TypeScript, Zod 3, Astro 5, Vitest, Playwright (verification only).

**Spec:** `docs/specs/2026-07-19-milo-v2-rethink-design.md` (approved 2026-07-19).

**Out of scope tonight** (next plans): intake pipeline (GMB + crawl), AWS publish wiring, GitHub remote creation, leads endpoints, AI assistant, non-home archetypes beyond the generic page shell, mobile hamburger JS beyond PoC parity.

---

## File Structure

```
milo/
  package.json                  # workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  docs/specs/…                  # approved spec (copied)
  docs/superpowers/plans/…      # this plan
  packages/
    schema/                     # @milo/schema — the contract
      package.json
      src/index.ts              # exports
      src/site-content.ts       # GymSiteContent + Section union
      src/sections.ts           # per-component section schemas (16)
      test/site-content.test.ts
      fixtures/iron-anchor.json # canonical fixture gym
    llm/                        # @milo/llm — ported OpenRouter client
      package.json
      src/llm-client.ts         # ported from websites/apps/api/src/ai/llm-client.ts
      test/llm-client.test.ts   # config + URL building unit tests (no network)
  templates/
    modern/                     # template = Astro components + tokens + manifest
      template.json             # name, tokens, component coverage list
      components/*.astro        # 16 section components + Nav + Footer
      layouts/Base.astro
  apps/
    renderer/
      package.json
      astro.config.mjs
      src/pages/index.astro     # renders fixture home page (env: GYM_JSON, TEMPLATE)
      src/lib/load-content.ts   # reads + zod-validates gym.json
      src/lib/resolve.ts        # section.type → component map for active template
    cli/
      package.json
      src/milo.ts               # build | preview | stubs: intake publish reskin studio
```

---

### Task 1: Workspace scaffold

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`.

- [x] **Step 1:** Write workspace root files. `pnpm-workspace.yaml` lists `packages/*`, `apps/*`. `.gitignore`: `node_modules`, `dist`, `.astro`, `.env*`.
- [x] **Step 2:** `git add -A && git commit -m "chore: scaffold milo v2 workspace"` (includes spec + this plan + `.poc-import/` snapshot of the proof-of-concept).

### Task 2: @milo/schema — the contract

**Files:** Create `packages/schema/{package.json,src/index.ts,src/site-content.ts,src/sections.ts,test/site-content.test.ts,fixtures/iron-anchor.json}`.

Sections are a discriminated union on `type` over the 16-component vocabulary from the spec:
`hero, program-cards, coach-grid, schedule, testimonials, faq, cta-band, location-map, contact-form, lead-form, pricing, feature-grid, content-block, media-block, stats-band, logo-strip`.
Each section schema carries its own render props (denormalized by generate; renderer stays dumb). Top level: `brand`, `business`, `nav`, `footer`, `pages[]` (each `{slug, archetype, seo, sections[]}`), plus content wells `programs[]`, `coaches[]`, `reviews[]`.

- [x] **Step 1:** Write failing test: `iron-anchor.json` fixture parses via `GymSiteContent.parse`; a fixture with a bogus `sections[].type` throws; missing `brand.name` throws.
- [x] **Step 2:** `pnpm --filter @milo/schema test` → FAIL (module not implemented).
- [x] **Step 3:** Implement `sections.ts` + `site-content.ts` + fixture (fixture = Iron Anchor with every section type used at least once across pages).
- [x] **Step 4:** `pnpm --filter @milo/schema test` → PASS.
- [x] **Step 5:** Commit `feat(schema): GymSiteContent contract + section vocabulary + fixture`.

### Task 3: modern template — port PoC components

**Files:** Create `templates/modern/template.json`, `layouts/Base.astro`, `components/{Nav,Hero,ProgramCards,FeatureGrid,Testimonials,CtaBand,Footer}.astro` — ported from `.poc-import/src/` (committed in Task 1), with props renamed to match the schema section props exactly. PoC "Steps" becomes `FeatureGrid` `variant="numbered"`.

- [x] **Step 1:** Port each component; props come from the matching section schema (e.g. `HeroSection` props). Tokens (`--accent #0464fc`, `--navy #000b27`, fonts) move to `template.json` + Base layout CSS vars.
- [x] **Step 2:** Commit `feat(template-modern): port proven PoC components onto schema props`.

### Task 4: renderer

**Files:** Create `apps/renderer/{package.json,astro.config.mjs,src/pages/index.astro,src/lib/load-content.ts,src/lib/resolve.ts}`.

- [x] **Step 1:** `load-content.ts` reads `process.env.GYM_JSON`, parses with `@milo/schema` (build fails loudly on invalid content — deterministic QA per spec).
- [x] **Step 2:** `resolve.ts` maps section `type` → imported component from `templates/modern`. Unknown type = build error (closed vocabulary, no silent fallbacks).
- [x] **Step 3:** `index.astro` renders the `home` page: Nav, then `page.sections` in order, then Footer.
- [x] **Step 4:** `GYM_JSON=../../packages/schema/fixtures/iron-anchor.json pnpm --filter renderer build` → builds clean.
- [x] **Step 5:** Commit `feat(renderer): schema-validated gym.json → modern template → static site`.

### Task 5: complete the modern component vocabulary

**Files:** Create in `templates/modern/components/`: `CoachGrid.astro`, `Schedule.astro`, `Faq.astro`, `LocationMap.astro`, `ContactForm.astro`, `LeadForm.astro`, `Pricing.astro`, `ContentBlock.astro`, `MediaBlock.astro`, `StatsBand.astro`, `LogoStrip.astro`, plus `FeatureGrid` variants `cards` (hero feature cards, ref vp-01), `dark` (amenities band, ref vp-06). Reference captures for fidelity live in the v1 session evidence; design tokens + patterns are established by Tasks 3 components.

- [x] **Step 1:** Build each component against its section schema; extend the fixture so home + supporting pages exercise every component.
- [x] **Step 2:** Renderer build passes; screenshot each section at 1440px and 375px; iterate by eye per component (Template Studio discipline: look, fix, re-shoot).
- [x] **Step 3:** Commit per component group: `feat(template-modern): <components>`.

### Task 6: @milo/llm — port the OpenRouter keeper

**Files:** Create `packages/llm/{package.json,src/llm-client.ts,test/llm-client.test.ts}` ported from `websites/apps/api/src/ai/llm-client.ts`; config via injected object (no Fastify env plugin dependency).

- [x] **Step 1:** Failing unit tests: OpenRouter URL building (base with/without `/v1`), header assembly, model pass-through. No network calls.
- [x] **Step 2:** Port + adapt; tests PASS.
- [x] **Step 3:** Commit `feat(llm): port OpenRouter client from v1`.

### Task 7: CLI skeleton

**Files:** Create `apps/cli/{package.json,src/milo.ts}`.

- [x] **Step 1:** `milo build --gym <path> --template modern --out <dir>` shells the renderer build with env; `preview` serves the output; `intake|publish|reskin|studio` print "not yet implemented — see docs/specs".
- [x] **Step 2:** `pnpm milo build --gym packages/schema/fixtures/iron-anchor.json` produces `dist/` with the site; verify `index.html` exists.
- [x] **Step 3:** Commit `feat(cli): milo build/preview + stubbed pipeline commands`.

### Task 8: second template from a second reference URL (process generalization)

**Reference:** `https://beanburito.github.io/free-intro-session-self-book-in-person/index.html`
**Files:** Create `templates/<name>/` (name chosen from the design's character after capture) — full Template Studio session #2: capture (1440 + 375, computed styles), port nothing — build the same 16-component vocabulary in this design's language, distinct tokens in its `template.json`.

- [x] **Step 1:** Playwright capture of the reference (desktop + mobile + computed styles + section inventory).
- [x] **Step 2:** Build the component vocabulary in the new design language; iterate by eye per component.
- [x] **Step 3:** **The proof:** render the SAME `iron-anchor.json` fixture through this template with zero fixture changes — `milo build --template <name>`. One gym, two templates = requirement #7 verified by construction, and the Studio process verified repeatable across reference URLs.
- [x] **Step 4:** Renderer `resolve.ts` gains a template registry (`modern` | `<name>`) — template selection is data, not code branches.
- [x] **Step 5:** Commit `feat(template-<name>): second Studio template from beanburito reference`.

### Task 9: verification + morning report

- [x] **Step 1:** Full-page Playwright screenshots (1440 + 375) of the built fixture site — **both templates**.
- [x] **Step 2:** Read every screenshot; fix anything off; re-shoot (final Studio pass).
- [x] **Step 3:** Update morning-review artifact: same gym side-by-side on both templates + repo summary. Final commit.

## Self-review

Spec coverage: contract (§Generator/§contract) → Task 2; template vocabulary (§components) → Tasks 3+5; deterministic build QA (§Build+publish) → Task 4 loud-fail validation; keepers (§Ported subsystem 2) → Task 6; CLI (§Ported subsystem 3) → Task 7. Deferred items match the spec's Deferred section plus: intake, publish/AWS, leads, assistant — each needs its own plan. No placeholders; types flow from Task 2 into 3-5 (single source: `@milo/schema`).
