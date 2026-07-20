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
| `templates/<name>` | A template: Astro components (full vocabulary) + `registry.ts` + `template.json` manifest + `docs/` |
| `apps/renderer` | gym.json + template → static site; schema-validated, loud failures |
| `apps/studio` | Template Studio tooling: `capture.mjs` (any URL → capture bundle), `shoot-site.mjs` (visual verification), `template-docs.mjs` (docs generator) |
| `apps/cli` | `milo` operator CLI |
| `.poc-import` | Historical: the throwaway PoC that proved the Template Studio process |

## Commands

```bash
pnpm test                                    # all package tests
pnpm milo build --gym <gym.json> --template modern --out <dir>
pnpm milo preview --template blackout        # serve last build
pnpm milo studio --url <reference-url>       # capture a reference site
pnpm milo docs                               # regenerate template docs from manifests
```

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
