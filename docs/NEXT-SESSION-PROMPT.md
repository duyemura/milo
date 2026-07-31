# Next session kickoff prompt

Copy everything below the line into a fresh session.

---

I'm continuing work on **Milo v2**, a gym website platform. The repo is at `~/pushpress/milo` (local git only — do NOT create a remote or push unless I explicitly say so). The old v1 repo `~/pushpress/websites` is a preserved archive; don't build there.

## Read these first

1. `~/pushpress/milo/docs/SESSION-3-REPORT.md` — intake close-out and current state.
2. `~/pushpress/milo/README.md` — repo map, commands, rules.
3. `~/pushpress/milo/docs/specs/2026-07-19-milo-v2-rethink-design.md` — approved design.

## Verify the foundation is green before doing anything

```bash
cd ~/pushpress/milo && pnpm test
```

Expected: **all 10 workspace projects green, 0 failing** (intake 58 tests, generate 10, publish 36, renderer 20, templates, schema, llm, studio, cli).

If anything is red, fix it before proceeding.

## What exists

- **`packages/intake`** + `milo intake` — DONE. Crawls a real gym, downloads GMB photos + page assets, writes `gym.json` + `context.json` + `business.json` + `integrations.json` + full crawl bundle.
- **`packages/generate`** + `milo generate` — DONE. Standalone docs → `gym.json` reprojection; also called internally by intake.
- **`packages/publish`** + `milo publish staging|production|rollback|status` — DONE. S3 + CloudFront KVS versioned deploy.
- **`apps/renderer`** — Astro static renderer, `GYM_JSON=... TEMPLATE=modern pnpm --filter renderer build`.
- **`templates/modern`** and **`templates/blackout`** — full 16-section templates.
- **`packages/schema`** — `GymDocuments`, `BrandTokens`, 16 section schemas.

## Core invariants (do not violate)

1. **Docs are the single source of truth.** After intake, all site changes flow through doc edits + rebuild.
2. **Templates own fonts + typography only.** JSON-LD, meta tags, structured data = renderer.
3. **Section content validated** via `Section.safeParse` before rendering. Malformed docs fail loudly.
4. **`SECTION_TYPES` is closed.** Adding a section = schema change + tests + both template components.
5. **No re-clone / re-sync from source.** Milo is system of record after join.

## Next target — real-gym end-to-end burn-in

The stack is built; now it needs to survive real gym data. Run the full pipeline against live gyms and harden from what breaks.

### Scope

Pick 3–5 real gym websites representing different underlying platforms (PushPress, Squarespace, Wodify, WordPress, Webflow, etc.). For each:

1. **Intake**
   ```bash
   GOOGLE_PLACES_API_KEY=… OPENROUTER_API_KEY=… \
     node apps/cli/src/milo.ts intake \
       --url https://<gym>.com \
       --name "Gym Name" \
       --city "City" \
       --state "ST" \
       --max-pages 15 \
       --out ./burnin/<gym-slug>
   ```
2. **Validate `gym.json`** — `GymDocuments.parse` must pass; every page needs ≥1 valid section.
3. **Build**
   ```bash
   node apps/cli/src/milo.ts build \
     --gym ./burnin/<gym-slug>/gym.json \
     --theme modern \
     --out ./burnin/<gym-slug>/dist
   ```
4. **Publish staging**
   ```bash
   AWS_PROFILE=unicorn node apps/cli/src/milo.ts publish staging \
     --dist ./burnin/<gym-slug>/dist
   ```
5. **Evaluate** — open the staging URL and score:
   - Content accuracy (does it represent the real gym?)
   - Section coverage (missing archetypes? thin placeholders?)
   - Asset quality (logo, hero, GMB photos, downloaded images)
   - Lighthouse / a11y gates (`apps/renderer/test/lighthouse.test.ts`, `gates.test.ts`)
   - Renderer errors or schema validation failures

### Hardening loop

For every failure, find the **root cause** and fix upstream:

- Bad crawl / missing page → `discover.ts`, `crawl.ts`, `rules.ts`.
- Bad content synthesis → prompt/template in `packages/generate`, `context.ts`, `classify.ts`.
- Missing archetype → `missingArchetypes()` logic or placeholder generation in `generateSite()`.
- Asset not downloaded / wrong path → `downloadAsset`, `downloadPageAssets`, `downloadGmbPhotos`.
- Brand/fonts wrong → `brand.ts`, Playwright font capture.
- Integration/analytics misdetected → `brand.ts` `detectAnalytics` / `fingerprintSoftware`.

Add a regression test in `packages/intake/test` or `packages/generate/test` for every fix. Update the bundled crawl rules if a whole class of URLs needs new handling.

### Output

Write `docs/BURN-IN-2026-07-29.md` (or dated equivalent) with:
- Gyms tested, platform, pages crawled, staging URLs.
- Pass/fail per evaluation dimension.
- Root-cause fixes applied and tests added.
- Remaining known gaps prioritized.

## Working style

- Brainstorm/plan before building (superpowers skills).
- TDD for every fix: red regression test → implementation → green.
- Commit frequently.
- Use agents for parallel independent gym runs.
- Before claiming anything works, run it and show evidence.
- Long captures/builds as background tasks with progress narration.
- Before any LLM-touching code: load the `claude-api` skill.

## Pending decisions (ask Dan, don't assume)

- Which live gyms to use for burn-in (and whether any need permission).
- Whether to create a GitHub remote for the milo repo.
- Whether to do a visual polish pass on templates before broader burn-in.
- Whether to keep the `--skip-crawl` flow or fold it into a future edit/rebuild command.
