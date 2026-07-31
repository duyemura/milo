# Session 3 Report — Intake close-out

**Date:** 2026-07-29  
**Branch:** `main` (merged)  
**Tests:** all 10 workspace projects green; `packages/intake` adds 58 tests, total monorepo suite now 238 passing, 0 failing.

---

## What `milo intake` does

`packages/intake` + `apps/cli/src/milo.ts` implement the one-time engine that turns a real gym's web presence into a `GymDocuments` fixture (`gym.json`) plus three intelligence docs and a local asset archive.

Pipeline (`runIntake` in `packages/intake/src/intake.ts`):

1. **Normalize base URL** — follow redirects to canonical origin (`discover.ts`).
2. **Operator-supplied identity** — `--name`, `--city`, `--state`, `[--country US]` drive the Google Places query and act as fallback when no match is found (`places.ts`).
3. **Places identity + GMB photos** — Places API (New) → `IdentityCrawl`; downloaded GMB photos are written to `assets/` and recorded in `crawl/gmb-assets.json` (`places.ts`, `crawl.ts`).
4. **Discovery** — probe `/sitemap.xml`, parse homepage nav, merge same-origin URLs, filter non-HTML + UGC, prioritize, cap at `--max-pages`, assign per-page LLM budget → `crawl/pages.json` (`discover.ts`). Custom crawl rules are supported via `--rules` (`rules.ts`).
5. **Wave-based crawl** — static fetch with Playwright fallback for JS-rendered pages, boilerplate strip, page-document extraction, per-page LLM classification, asset collection. Newly-seen same-origin links feed back into the queue up to the cap (`crawl.ts`, `crawl-graph.ts`).
6. **Full internal link map** — `crawl/links.json` records every same-origin URL seen, crawled or not, with edges — the gym's real site graph independent of `--max-pages` (`crawl-graph.ts`).
7. **Brand extraction** — colors, fonts (computed via Playwright when needed), logo, socials, gym-software fingerprint, analytics from homepage HTML/CSS (`brand.ts`).
8. **Social scrape (best-effort)** — homepage social links are scraped and the resulting bio/caption text is appended to the homepage body so the LLM sees richer signals (`social.ts`).
9. **Asset download** — page images + GMB photos are downloaded locally and referenced by local path in generated content (`crawl.ts`).
10. **Context + business intelligence** — `context.json` via `analyzeContext`, `business.json` + `integrations.json` via deterministic signal mapping + LLM (`classify.ts`, `context.ts`).
11. **Site generation** — `packages/generate`'s `generateSite()` projects the crawl into `gym.json`, synthesizing any missing archetype pages as placeholders when input is thin.
12. **Validate + write** — every output is Zod-validated before write; `gym.json` is deep-validated against `GymDocumentsStrict` so malformed sections self-correct inside the LLM retry loop.

## Injected-adapter test strategy

No live HTTP in CI. All external I/O is behind small interfaces with fakes in `packages/intake/test/fakes.ts`:

- `FakePlacesClient` — returns a queued raw Places result and fake photo URIs.
- `FakePageFetcher` — maps URL/pathname to static HTML, with an optional list of URLs to throw on.
- `fakeChat(responses)` / `fakeChatWithCapture(responses)` — returns queued LLM JSON and optionally records prompts for assertions.
- `fakeSocialScraper(profiles)` — returns queued social profiles per platform.

`test/intake.test.ts` runs `runIntake` end-to-end with these fakes, asserts the output files are written, and validates `gym.json` against `GymDocuments`. Additional unit tests cover each pure stage (discover, crawl, crawl-graph, brand, places, classify, context, schemas). Mirrors the `packages/publish` adapter pattern.

## Manual smoke-test command (real keys + network required)

```bash
GOOGLE_PLACES_API_KEY=… OPENROUTER_API_KEY=… \
  node apps/cli/src/milo.ts intake \
    --url https://<a-real-gym>.com \
    --name "Gym Name" \
    --city "City" \
    --state "ST" \
    --max-pages 10 \
    --out ./intake-output

# Reproject from docs without re-crawling (optional):
OPENROUTER_API_KEY=… node apps/cli/src/milo.ts generate --docs ./intake-output

# Build:
node apps/cli/src/milo.ts build \
  --gym ./intake-output/gym.json \
  --theme modern \
  --out ./dist

# Publish staging:
AWS_PROFILE=unicorn node apps/cli/src/milo.ts publish staging --dist ./dist
```

Set `MILO_CAPABLE_MODEL` / `MILO_FAST_MODEL` to valid OpenRouter slugs if the defaults need adjustment.

## Status

- **Intake — DONE.** `milo intake` is wired into the CLI, fully tested, and documented in `README.md`.
- **Generate — built and used by intake.** `milo generate` also exists as a standalone reprojection command.
- **Next target — real-gym end-to-end burn-in.** Run `intake → build → publish staging` against live gyms and harden from real data. See `docs/NEXT-SESSION-PROMPT.md`.
