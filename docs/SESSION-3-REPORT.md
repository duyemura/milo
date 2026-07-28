# Session 3 Report — Intake

**Date:** 2026-07-28
**Branch:** `intake` (local only — no remote)
**Tests:** 209 passing, 0 failing across the whole monorepo (was 119 pre-intake; `packages/intake` adds 53)

---

## What was built

`packages/intake` + the `milo intake --url <gym-url>` command — the one-time engine that turns a real gym's web presence into a `GymDocuments` fixture (`gym.json`) plus three intelligence docs and a local asset archive. Built from `docs/superpowers/specs/2026-07-21-intake-design.md` via `docs/superpowers/plans/2026-07-28-intake.md` (16 TDD tasks, subagent-driven with a spec+quality review after each substantive task).

### The pipeline (`runIntake`)

1. **Normalize base URL** — follow redirects to the canonical origin (`discover.ts`).
2. **Places identity** (best-effort) — Google Places API (New) → `IdentityCrawl` (`places.ts`); no match ⇒ warn + crawl-only identity.
3. **Discovery** — probe `/sitemap.xml`, parse nav, merge same-origin, filter non-HTML + UGC, prioritize (homepage→about→coaches→programs→pricing→…), cap at `--max-pages`, assign per-page LLM budget → `pages.json` (`discover.ts`).
4. **Wave-based crawl with queue expansion** — static fetch (Playwright fallback for JS-rendered pages), boilerplate-stripped page documents, per-page LLM classification, asset collection. Newly-seen same-origin links feed back into the queue up to the cap (`crawl.ts`, `crawl-graph.ts`, orchestrated in `intake.ts`).
5. **Full internal link map** — `crawl/links.json` records **every** same-origin URL seen, crawled or not, with edges — the gym's real site graph independent of `--max-pages` (`crawl-graph.ts`). *(Added at Dan's request beyond the original spec.)*
6. **Brand extraction** — colors, fonts, logo, socials, gym-software fingerprint, analytics detection from homepage HTML/CSS (`brand.ts`).
7. **LLM synthesis Pass 1** — `gym.json` (`GymDocuments`) + `context.json`, with context-window budgeting and **deep per-section content validation** (`GymDocumentsStrict`) so malformed sections self-correct inside the retry loop (`synthesize.ts`).
8. **LLM Pass 2** — `business.json` + `integrations.json` (deterministic signal mapping + a narrative LLM call) (`classify.ts`).
9. **Validate + write** — every output Zod-validated before write.

### Design choices worth knowing

- **Injected I/O, no live HTTP in CI.** `PlacesClient`, `PageFetcher`, and the `chat` function are interfaces; fakes drive a full offline end-to-end test. Mirrors the `packages/publish` adapter pattern.
- **`llmJson` helper** closes the gap that `@milo/llm` only offers `jsonMode`, not schema enforcement: JSON-mode → Zod validate → retry with the error fed back so the model self-corrects.
- **`gym.json` targets `GymDocuments` from `@milo/schema`** — not redefined. Section content is deep-validated at synthesis *and* by the renderer's `Section.safeParse` at build (two gates, earliest wins).

### Wiring / cross-package

- `milo intake` wired into `apps/cli/src/milo.ts`; `@milo/intake` + `@milo/llm` added to the CLI deps.
- **`@milo/llm` fix:** `LlmClientError` used TS constructor parameter properties, which Node 24's native type-*stripping* (how the CLI runs `.ts`) can't transform — converted to explicit field assignments. Only surfaced when running the CLI end-to-end; vitest/esbuild had masked it.

## Review-caught bugs fixed (all with regression tests)

The per-task review loop caught real correctness bugs, not just style:

- `discover.buildInventory`: `capped` double-counted filtered pages → now counts survivors beyond `maxPages`.
- `crawl-graph.buildLinkMap`: no guard on cross-origin `from`-keys → added, prevents graph corruption.
- `crawl.ts` (four): og:image **and** meta-description regexes required a fixed attribute order (silently dropped data on common CMS output) → order-independent `metaContent` helper; error pages (4xx/5xx) stored as real pages → `res.ok` gate; asset filename collisions (`/en/hero.jpg` vs `/fr/hero.jpg`) → hash-prefixed names.
- `brand.familyOf`: `tbody { … }` hijacked a `body` font lookup → `\b`-anchored selector.
- `intake.ts`: per-page fetch failures could crash the whole run → try/catch skip + test; nav provenance collapsed to `sitemap` in rebuilt `pages.json` → preserved.

## Not built (next)

- **Generate** (`milo generate`) — richer `GymDocuments` → `gym.json` via LLM + archetype recipes, for gyms without enough crawlable content. Intake already produces a valid `gym.json`; generate is the from-thin-input path.
- **Analytics injection into the renderer** — read `integrations.json` at build, inject present tags into `<head>` (spec'd as a separate renderer feature).
- Web-search enrichment, multi-location intake, video assets (spec §out-of-scope).

## Try it (needs real keys + network)

```bash
GOOGLE_PLACES_API_KEY=… OPENROUTER_API_KEY=… \
  node apps/cli/src/milo.ts intake --url https://<a-real-gym>.com --max-pages 10
# then render what it produced:
TEMPLATE=modern GYM_JSON=intake-output/gym.json pnpm --filter renderer build
```

Set `MILO_CAPABLE_MODEL` / `MILO_FAST_MODEL` to valid OpenRouter slugs — the defaults (`anthropic/claude-opus-4-8`, `anthropic/claude-haiku-4-5`) may need adjusting to whatever slugs OpenRouter currently exposes.

## Branch

Work is on `intake` (local only). `phase1a-template-spine` was already merged into `main`; `intake` branches off the current `main` tip. Merge when ready — no remote exists per the repo rule.
