# Kickoff prompt for the next Milo v2 session

Copy everything below the line into a fresh session.

---

I'm continuing work on **Milo v2**, a gym website platform. The repo is at
`~/pushpress/milo` (local git only — do NOT create a remote or push unless I
explicitly say so). The old v1 repo `~/pushpress/websites` is a preserved
archive; don't build there.

**Read these first, in order, before doing anything:**
1. `~/pushpress/milo/docs/SESSION-1-REPORT.md` — what exists and why.
2. `~/pushpress/milo/docs/specs/2026-07-19-milo-v2-rethink-design.md` — approved design.
3. `~/pushpress/milo/README.md` — repo map, commands, rules.
4. `~/pushpress/milo/packages/schema/src/` — the GymSiteContent contract everything depends on.

**Core principle (do not violate):** docs are the single source of truth;
templates are skins; the section vocabulary (16) and page archetypes (15) are
CLOSED — extending them is a schema change with tests, never a one-off
component. Unknown section type or invalid gym.json must fail the build. Gyms
vertical only. Template creation is a supervised Template Studio session
(`milo studio --url …` → build the 16 components against the capture → human
acceptance), never an unattended judge/auto-fix loop.

**Verify the foundation still works** (should be green/fast):
```
cd ~/pushpress/milo && pnpm test
pnpm milo build --gym packages/schema/fixtures/iron-anchor.json --template blackout --out /tmp/milo-check
```

**This session I want to build: `intake` — the doc layer.**  (Adjust if I say otherwise.)
The goal: `milo intake --url <a-real-gym-website>` gathers a gym's business into
structured docs that a later `generate` step will turn into `GymSiteContent`.
Scope for this session:
- GMB lookup + homepage crawl for assets/brand + targeted subpage fetch
  (about/coaches/schedule/programs/pricing) for facts. Port GMB enrich from the
  archive (`~/pushpress/websites/apps/api`) — find it, don't reinvent.
- Define the gym **doc schemas** in `packages/schema` (identity/brand, programs,
  coaches, schedule, memberships/pricing, location/hours, testimonials, faq,
  lead-process, media-library, seo-profile, site-hierarchy) — same Zod-contract
  discipline as GymSiteContent, with tests and a fixture.
- Use `@milo/llm` (already ported) for extraction; write outputs to docs.
- Do NOT build generate/publish/leads/assistant this session.

**Working style:** brainstorm/plan before building (superpowers skills), TDD on
schemas, commit frequently with the `Co-Authored-By: Claude Fable 5` trailer,
use TaskCreate to track multi-step work, and run long captures/builds as
background tasks. Before writing any LLM-touching code, load the claude-api
skill. Verify with real screenshots via `apps/studio/src/shoot-site.mjs`, don't
claim success without evidence.

**Also pending my decision (ask me, don't assume):** visual pass/fail on the
`modern` and `blackout` templates, and whether to create a GitHub remote.
