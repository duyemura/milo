# Next session kickoff prompt

Copy everything below the line into a fresh session.

---

I'm continuing work on **Milo v2**, a gym website platform. The repo is at `~/pushpress/milo` (local git only — do NOT create a remote or push unless I explicitly say so). The old v1 repo `~/pushpress/websites` is a preserved archive; don't build there.

## Read these first

1. `~/pushpress/milo/docs/SESSION-2-REPORT.md` — full state of what was built and what's next.
2. `~/pushpress/milo/docs/specs/2026-07-19-milo-v2-rethink-design.md` — approved design.
3. `~/pushpress/milo/README.md` — repo map, commands, rules.

## Verify the foundation is green before doing anything

```bash
cd ~/pushpress/milo && pnpm test
```

Expected: **119 tests passing, 0 failing** across packages/schema, packages/llm, apps/studio, apps/renderer (includes Lighthouse gate perf=99, SEO=100, portability gate), templates/modern (31), templates/blackout (39).

If anything is red, fix it before proceeding.

## What exists

- **`templates/modern`** — Template #1: Montserrat, navy+blue, all 16 sections, full SEO/AEO @graph
- **`templates/blackout`** — Template #2: Oswald, dark, sharp edges, all 16 sections
- **`apps/renderer`** — Astro static renderer, `TEMPLATE=modern|blackout`, `GYM_JSON=path/to/gym.json`
- **`packages/schema`** — `GymDocuments`, `Identity` (with geo/GBP/priceRange), 16 section schemas, `tokensToCss`
- **`apps/studio`** — Playwright capture tools

## Core invariants (do not violate)

1. **Templates own fonts + typography only.** All JSON-LD, meta tags, structured data = renderer.
2. **Section content validated** via `Section.safeParse` before rendering. Malformed docs fail loudly.
3. **`SECTION_TYPES` is closed.** Adding a section = schema change + tests + both template components.
4. **`GymDocuments` is the single source of truth.** Templates are skins.
5. **Intake populates docs once.** After join, Milo is system of record.

## Status (updated 2026-07-28)

- **Publish — DONE** (`packages/publish`, wired into CLI). Option A below is complete.
- **Intake — DONE** (`packages/intake`, `milo intake`). See `SESSION-3-REPORT.md`. Option B below is complete, on branch `intake` (not yet merged to `main`).
- **Generate — NOT built.** This is the next build (Option C below).

## What to build next (ask Dan which one)

### Option A: Publish (`apps/publish`) — ✅ DONE
S3 + CloudFront staging/production. Port from `~/pushpress/websites/apps/api/src/services/`:
- `cloudfront.ts` — KVS router for slug → S3 prefix
- `s3.ts` — upload dist/ to `pushpress-marketing-dev` (unicorn AWS profile)

Flow: `milo build → dist/ → milo publish staging → S3 upload → viewable at CDN URL`
Then: `milo publish production → swap KVS entry → site goes live`

### Option B: Intake (`apps/cli intake`) — ✅ DONE (branch `intake`)
`milo intake --url <gym-url>` → populates GymDocuments from a real gym.
- GMB lookup → identity (name, address, phone, hours, geo)
- Homepage crawl → brand (logo, colors, hero image)  
- Targeted subpage fetch → program/coach/schedule/pricing content via @milo/llm

Port from `~/pushpress/websites/apps/api/src/services/gmb.ts`

### Option C: Generate (`apps/cli generate`) — ⬅ NEXT
`GymDocuments` → `gym.json` (complete site content) via LLM + archetype recipes.
Reads all doc fields, produces structured content the renderer needs.

## Working style

- Brainstorm/plan before building (superpowers skills)
- TDD: red test → implementation → green
- Commit frequently
- Use agents for parallel independent work
- PR review after each logical batch
- Before claiming anything works, run it and show evidence
- Long builds/captures as background tasks with progress narration
- Before any LLM-touching code: load the `claude-api` skill

## Pending decisions (ask Dan, don't assume)

- Which of A/B/C to build first
- Whether to create a GitHub remote for the milo repo
- Whether to do a visual polish pass on both templates before publish
