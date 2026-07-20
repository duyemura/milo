# Milo v2 — Session 1 Report (2026-07-19 → 07-20)

## What this session was

Milo v1 (clone → extract → LLM-generate → LLM-judge → auto-fix) floundered for
two weeks: evals frozen at 78/100, ~40 consecutive fix-commits. We scrapped the
architecture, redesigned from first principles, proved the riskiest assumption
with a throwaway PoC, then built the v2 foundation overnight.

## Decisions made (all approved by Dan)

- **Gyms/fitness vertical only.** Depth over breadth.
- **Docs are the single source of truth.** Templates are skins; everything
  between docs and site is deterministic.
- **Template Studio, not a pipeline.** Templates are built in supervised
  sessions from a reference URL (or original design), human-accepted. No
  unattended extract→judge→auto-fix — that is what killed v1.
- **Closed vocabularies as the contract.** 16 section components + 15 page
  archetypes. Every template implements all 16 → any gym renders on any
  template by construction (requirement #7).
- **Rebuild fidelity = professional redesign**, not pixel parity. Client brand
  + content carry over; the template's design wins.
- **Crawl = intelligence only.** Assets from homepage + GMB; facts from a few
  key subpages. No BFS, no asset rehosting, no clone-as-a-product tier.
- **Fresh repo, port keepers.** New repo; port GMB enrich, S3/CloudFront
  publish, OpenRouter client, renderer bones. Delete section-extract, adapt,
  spec-audit, template-eval, pixel-diff, nav scraping.
- **Repo is LOCAL ONLY** at `~/pushpress/milo`. No git remote until Dan
  decides. v1 repo (`~/pushpress/websites`) pushed to origin and preserved as
  the archive.

## Proof (before building)

Ran a Template Studio session against `pushpress-site-modern.webflow.io`, then
against `beanburito.github.io/free-intro-session-self-book-in-person`. Built
components, rendered a *different* fictional gym through them, iterated by eye
against the captures. This retired the "can Claude faithfully reproduce a
design" risk. Artifacts (session-scoped): the reference-vs-rebuild comparison
and the overnight report.

## What got built (`~/pushpress/milo`, 9 commits, 23 tests green)

| Package/App | Contents |
|---|---|
| `packages/schema` | `GymSiteContent` (closed 16-section discriminated union, 15 archetypes, exactly-one-home rule), `TemplateManifest`, canonical `fixtures/iron-anchor.json` exercising every section type. Unknown section/archetype → parse error. Tested. |
| `packages/llm` | Ported OpenRouter/Ollama client, injected config (no Fastify dep), `LlmCostAccumulator`. 9 unit tests, no network. |
| `templates/modern` | From the webflow reference. All 16 components + Nav/Footer/Base, `template.json` manifest, `docs/design-language.md`, generated `docs/components.md`. Montserrat 900 / off-white / electric blue / navy bands. |
| `templates/blackout` | From the beanburito reference. All 16 components. Black brutalist, Outfit 900 uppercase, skewed parallelogram buttons, blue/black checkerboard, diagonal-clipped bands. |
| `apps/renderer` | gym.json + template → static site. Schema-validated (loud failure). Templates discovered by glob, **lazily loaded** (CSS emits on import — only the active template may be imported). |
| `apps/studio` | `capture.mjs` (any URL → capture bundle: desktop+mobile shots, computed styles, section inventory), `shoot-site.mjs` (build + screenshot a site for verification), `template-docs.mjs` (manifest → components.md). |
| `apps/cli` | `milo build/preview/studio/docs` functional; `intake/publish/reskin` stubbed with spec pointers. |

**Requirement #7 proven:** the same `iron-anchor.json` renders through both
templates with zero content changes — `--template` is the only switch.

## Bug caught and fixed overnight

Importing every template registry statically bundled every template's CSS
(Vite emits CSS on import, not render), so `modern` briefly rendered with
`blackout`'s black background. Fixed by lazy per-template glob loading in
`apps/renderer/src/lib/resolve.ts`. General root-cause fix, not a per-template
patch.

## Not built yet (next sessions, per spec sequencing)

1. **intake** — GMB lookup + homepage/subpage crawl → gym docs (the doc layer
   that sits behind gym.json).
2. **generate** — docs → `GymSiteContent` using the manifest's archetype
   recipes; LLM only for genuine copy gaps, written back to docs.
3. **publish** — port S3 immutable-prefix + CloudFront pointer-swap; explicit
   approval gate; 301 redirect map; domain attach.
4. **leads** — form system + native-form proxy + attribution.
5. **AI assistant** — edits docs (never HTML), preview/publish gated.

## Key files to read first next session

- `docs/specs/2026-07-19-milo-v2-rethink-design.md` — the approved design.
- `docs/superpowers/plans/2026-07-19-milo-v2-rebuild.md` — session-1 plan (done).
- `README.md` — repo map + commands + rules.
- `packages/schema/src/` — the contract everything depends on.

## Open decisions for Dan

1. Visual acceptance of `modern` and `blackout` (morning-review artifact).
2. Whether/where to create a GitHub remote (nothing pushed yet).
