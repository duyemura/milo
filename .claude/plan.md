# Plan: Make `milo intake` progressive — thin first, enrich if possible

## Decision
`milo thin` as a standalone command is the wrong shape. `milo intake --url <url>` should always start with the thin layer (GMB + homepage + social scrape) and then progressively enrich with subpage crawl. If no subpage data is available, the generator still emits a valid site with clear placeholder pages/sections that an operator can edit or delete.

## Implementation

### 1. CLI
- Remove the `milo thin` command from `apps/cli/src/milo.ts`.
- Keep `milo intake --url <url>` as the single entry point.
- No new flags needed; existing flags (`--max-pages`, `--include-ugc`, `--concurrency`, `--rules`) continue to control crawl depth.

### 2. Intake orchestrator (`packages/intake/src/intake.ts`)
Refactor `runIntake` into ordered phases:
1. **Thin phase (always runs)**
   - Normalize URL + fetch homepage.
   - Google Places lookup → `identity`.
   - Extract homepage as a `PageDocument`.
   - Extract social links + scrape profiles.
   - Extract brand signals (colors, fonts, logo, analytics, software).
2. **Crawl phase (best-effort)**
   - Discover nav/sitemap subpages.
   - Crawl + classify subpages up to `--max-pages`.
   - If discovery yields only the homepage (or all subpage fetches fail), log a warning and continue with thin data.
3. **Synthesis phase**
   - Combine homepage + any crawled subpages.
   - Run `classifyBusiness` and `analyzeContext`.
   - Determine `missingArchetypes` from standard gym page set minus archetypes present in real pages.
   - Call `generateSite` with optional `placeholderArchetypes`.
   - Write `gym.json`, `context.json`, `business.json`, `integrations.json`, and the crawl bundle.

### 3. Generator placeholder support (`packages/generate/src/generate.ts`)
- Add `placeholderArchetypes?: string[]` to `GenerateSiteInput`.
- Update the system prompt: "If a standard archetype (about, coaches, programs, pricing, contact/location) is listed in placeholderArchetypes and no crawl doc covers it, create that page with a single clear placeholder section. Placeholder text must obviously signal it is awaiting real content (e.g. 'Add coach bio here') so operators know to edit or delete it."
- This keeps the generator generic and gym-vertical-agnostic; the list of archetypes is supplied by intake.

### 4. Tests
- Update `packages/intake/test/intake.test.ts` to assert that intake with only a homepage still produces a valid `gym.json` with multiple pages (placeholders).
- Keep existing full-crawl tests passing.
- Delete or repurpose `packages/intake/test/thin.test.ts` — the thin path is now covered by the updated intake tests.
- Keep `packages/intake/test/social.test.ts` for the social parsing helper.

### 5. Cleanup
- Remove `runThinIntake` export from `packages/intake/src/index.ts` (keep it internal or delete it if fully merged into `runIntake`).
- Keep `social.ts` and `createRealSocialScraper` because intake still uses them.

## Risk + mitigation
| Risk | Mitigation |
|---|---|
| Refactor breaks full-crawl tests | Keep existing test fixtures; add a homepage-only fixture for thin fallback |
| Placeholder pages look too real | Prompt explicitly requires obvious placeholder copy |
| Generator creates wrong page count | Validate output with `GymDocuments.parse` and assert expected archetypes/slugs |

## Success criteria
1. `milo intake --url <gym>` produces a valid `gym.json` even when no subpages are found.
2. Full-crawl path still produces richer output when subpages exist.
3. `pnpm --filter @milo/intake test` and `pnpm --filter @milo/generate test` pass.
4. `milo thin` no longer exists as a command.
