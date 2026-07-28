# Milo v2

Gym website platform: intelligence-gather a gym's business into structured
docs, then render those docs through hand-approved Astro templates. Docs are
the single source of truth; templates are skins; everything between them is
deterministic.

- **Spec:** `docs/specs/2026-07-19-milo-v2-rethink-design.md`
- **Build plan (session 1):** `docs/superpowers/plans/2026-07-19-milo-v2-rebuild.md`

## Layout

| Path | What |
|---|---|
| `packages/schema` | The contract: `GymSiteContent` (closed 16-section vocabulary, 15 page archetypes) + `TemplateManifest` + fixture gym |
| `packages/llm` | OpenRouter/Ollama client (ported v1 keeper), injected config, cost accumulator |
| `packages/intake` | `milo intake` engine: crawl a real gym's site → `gym.json` + `context/business/integrations.json` + local assets. Injected `PlacesClient`/`PageFetcher`/`chat` (fakes in tests, no live HTTP in CI) |
| `packages/publish` | S3 + CloudFront versioned deploy (staging/production/rollback/status) |
| `templates/<name>` | A template: Astro components (full vocabulary) + `registry.ts` + `template.json` manifest + `docs/` |
| `apps/renderer` | gym.json + template → static site; schema-validated, loud failures |
| `apps/studio` | Template Studio tooling: `capture.mjs` (any URL → capture bundle), `shoot-site.mjs` (visual verification), `template-docs.mjs` (docs generator) |
| `apps/cli` | `milo` operator CLI |
| `.poc-import` | Historical: the throwaway PoC that proved the Template Studio process |

## Commands

```bash
pnpm test                                    # all package tests
pnpm milo intake --url <gym-url>             # crawl a real gym → intake-output/
pnpm milo build --gym <gym.json> --template modern --out <dir>
pnpm milo preview --template blackout        # serve last build
pnpm milo studio --url <reference-url>       # capture a reference site
pnpm milo docs                               # regenerate template docs from manifests
pnpm milo publish staging|production|rollback|status
```

## Intake

`milo intake --url <gym-url>` crawls a gym's real web presence and writes a
`GymDocuments` fixture plus intelligence docs — the one-time seed that populates
the docs before a gym joins Milo.

```bash
milo intake --url https://<gym>.com \
  [--out ./intake-output] [--max-pages 25] [--concurrency 3] \
  [--include-ugc] [--skip-crawl]        # --skip-crawl re-runs synthesis on an existing crawl/ bundle
```

Requires env `GOOGLE_PLACES_API_KEY` (identity lookup) and `OPENROUTER_API_KEY`
(LLM synthesis). Optional model overrides: `MILO_CAPABLE_MODEL`, `MILO_FAST_MODEL`.

Output layout:

```
intake-output/
  gym.json              # GymDocuments — feed straight to `milo build`
  context.json          # ICP, brand voice, positioning, objections, SEO
  business.json         # tech stack, marketing maturity, pricing signals
  integrations.json     # detected analytics + gym software (operator-editable)
  assets/               # downloaded images + fonts (local paths in gym.json)
  crawl/                # raw bundle: identity.json, brand.json, pages.json,
                        #   links.json (FULL internal link graph), pages/<slug>.json
```

Every output is Zod-validated before write; `gym.json`'s section content is
deep-checked against the `Section` schema during synthesis so malformed
sections self-correct in the LLM retry loop. `crawl/links.json` records every
same-origin URL seen — crawled or not — as the gym's real site map, independent
of `--max-pages`.

## Templates

| Name | Character | Reference |
|---|---|---|
| `modern` | Friendly bold: Montserrat 900, off-white, electric blue, navy bands | pushpress-site-modern.webflow.io |
| `blackout` | Brutalist: black ground, Outfit 900 uppercase, skewed buttons, checkerboard | beanburito.github.io free-intro |

Any valid gym.json renders through any template (`--template` is the only
switch). Adding a template = a Template Studio session: `milo studio --url …`
to capture, build the 16 components against the capture, write the manifest +
design-language doc, add nothing else — the registry glob discovers it.

## Rules

- The section vocabulary and archetype list are **closed**. Extending them is
  a schema change with tests, never a one-off component.
- Unknown section type or invalid gym.json = build **error**. No fallbacks.
- Only the active template's registry may be imported per build (CSS emits on
  import — see `apps/renderer/src/lib/resolve.ts`).
- Templates document themselves: `template.json` (machine) + `docs/` (human).
  `components.md` is generated — edit the manifest, run `pnpm milo docs`.
- No GitHub remote until Dan creates one deliberately.
