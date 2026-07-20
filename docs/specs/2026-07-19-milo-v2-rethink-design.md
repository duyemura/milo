# Milo v2 — System Rethink Design

**Date:** 2026-07-19
**Status:** Approved design, pre-implementation
**Supersedes:** the v1 clone/extract pipeline architecture (see "What v2 deletes" below)

## Why v2

Two weeks of v1 work stalled. Root cause: the system stacked five lossy automated
layers (Playwright extraction → LLM section detection → LLM component generation →
LLM visual judging → LLM auto-fix) and needed the *product* of the chain to be
excellent. Component evals plateaued at 78/100 across the board; the commit log
became ~40 consecutive `fix:` commits patching the pipeline instead of shipping
sites. v2 puts humans where judgment lives (template craft, doc review) and
automation where mechanics live (mapping, rendering, deploying). Every automated
step in v2 is deterministic and testable.

## Scope

**Gyms and fitness businesses only.** No generic business support. Every layer —
doc schemas, intake prompts, archetypes, SEO — goes deep on the fitness vertical
instead of wide across industries. This aligns with PushPress's customer base and
allows future integration with the PushPress platform API (e.g., live schedule
data instead of scraped schedules).

## Core principle

**The Business Profile (docs) is the single source of truth. Templates are
hand-approved skins. Everything else is either a renderer of the docs or an
editor of the docs.**

Consequences that fall out for free:
- Re-render any client onto any template at any time (docs unchanged, skin swapped).
- AI assistant edits = doc edits + rebuild. Never HTML manipulation.
- Future features (blog posts, new pages, pillar pages) = new doc entries + existing archetypes.

## The contract: components + page archetypes

Two closed vocabularies form the system contract. Every template implements the
full component vocabulary in its own visual style; every client site is docs
mapped into archetype pages. Because both vocabularies are closed, **any client
renders on any template, guaranteed by construction.**

### Section components (every template implements all)

| Component | Purpose |
|---|---|
| `hero` | Page-top statement + primary CTA |
| `program-cards` | Programs/services grid or list |
| `coach-grid` | Staff/coaches with bios |
| `schedule` | Class schedule (scraped now; PushPress API later) |
| `testimonials` | Social proof / reviews |
| `faq` | FAQ with AEO schema |
| `cta-band` | Conversion band |
| `location-map` | Map + address + hours |
| `contact-form` | General contact |
| `lead-form` | Lead-gen form (our form system) |
| `pricing` | Memberships/pricing tables |
| `feature-grid` | Value props / differentiators |
| `content-block` | Rich text/content section |
| `media-block` | Image/video + copy split |
| `stats-band` | Numbers/metrics band |
| `logo-strip` | Affiliations/certifications/press |

### Page archetypes (compositions of components, SEO treatment baked in)

`home`, `about`, `coaches`, `programs-index`, `program-detail`, `schedule`,
`pricing`, `location-contact`, `drop-in`, `getting-started` (lead landing),
`landing-page` (campaign/lead-gen), `pillar-page`, `blog-index`, `blog-post`,
`testimonials`.

Nav derives from the pages that exist in the site-hierarchy doc. Nothing is
scraped or reconciled.

## Template Studio (template creation)

Template creation is a **supervised interactive session** (Dan + Claude), not an
unattended pipeline. Two supported inputs:

1. **Reference URL** — Playwright captures the reference site: full-page
   screenshots per page type, computed styles, palette, fonts, spacing.
   Triangulation rule: DOM for structured values, screenshots for visual
   appearance. Claude then builds the template component by component, rendering
   each with fixture content and visually comparing side-by-side against the
   capture, iterating with eyes until faithful.
2. **Original design** — same session; reference is a mockup/Figma export/verbal
   direction instead of a capture.

**Acceptance is human**: Dan approves the rendered template. No LLM visual
judges, no automated scoring loop. Finish line is definite: all 16 components
implemented and approved.

Output: a template in the library = one visual implementation of the full
component vocabulary + design tokens (colors, fonts, spacing, radius). Client
brand injects through tokens only (logo, brand colors, fonts); the template owns
layout, the client owns identity.

Templates are created rarely (target library: 5–20). Time investment of hours
per template is acceptable and correct.

## Business Profile (the docs)

Structured, versioned, per-client, stored in DB. Gym-native doc types:

- **identity/brand** — name, logo, brand colors, fonts, voice
- **programs/services** — classes, training, specialty programs
- **coaches/staff** — bios, photos, certifications
- **schedule** — class timetable
- **memberships/pricing** — plans, drop-in rates
- **location/hours/contact** — from GMB, authoritative
- **testimonials/social-proof** — reviews, transformations
- **faq**
- **lead-process** — how leads are handled, forms, funnels, external systems (GHL etc.)
- **media-library** — client photos/assets (from homepage + GMB)
- **seo-profile** — service area, local keywords, target queries
- **site-hierarchy** — which pages exist; nav derives from this

All docs editable forever via UI or AI assistant. Any doc change → rebuild →
live site reflects it.

## Intake (per-client pipeline)

```
GMB lookup            → authoritative facts + images
homepage crawl        → brand assets, copy, hero imagery
targeted subpage fetch → facts only, from key pages discovered in nav:
                         about / coaches / schedule / programs / pricing
LLM extraction        → doc drafts (gym-aware prompts)
human/AI review       → docs finalized
```

No BFS crawl. No full-site asset rehosting. Assets come from homepage + GMB only.

## Generator (docs → SiteContent)

- Deterministic-first: docs → typed `GymSiteContent` (Zod schema in
  `packages/schema`) is mostly mechanical mapping.
- LLM used only for genuinely generative gaps (copy the client never had, page
  composition choices). **Every LLM output is written back into the docs** so
  rebuilds are stable (no regeneration drift) and all AI-written content is
  reviewable/editable.

## Build + publish

```
docs → GymSiteContent → Astro render → S3 staging → explicit publish swap (CloudFront)
```

Ported from v1 (this path worked). Publishing to production always requires
explicit approval. Pre-publish QA is deterministic: broken links, missing
images, structured-data validation, Lighthouse floor. No LLM visual judging.

## SEO / AEO / local SEO (template-layer guarantee)

Baked into every template once, inherited by every client site:
- JSON-LD: `ExerciseGym` / `HealthClub` LocalBusiness schema from the GMB doc
- Per-page meta + OG, sitemap, robots, llms.txt
- FAQ schema on faq components (AEO)
- Local SEO: service-area and city/keyword integration from seo-profile doc
- Pillar-page archetype for topical authority

Built following the seo-aeo-best-practices skill.

## AI assistant

Operates on **docs, never HTML**. Tool surface: read docs, propose doc edit,
preview build, publish (gated). Deterministic docs→site makes every AI edit
previewable and safe. Blog posts and new pages later are the same loop with new
doc types — no new machinery.

## Leads

- **Own form system**: form defined as a doc, rendered by template components
  (`lead-form`, `contact-form`), POSTs to our `/leads` endpoint → stored →
  forwarded (email / webhook / GHL API).
- **Attribution**: UTM params + referrer + landing page captured as hidden
  fields on every form submit, stored with the lead. Gyms (and our own AI
  content loop later) need to know which page/campaign produced each lead.
- **External form preservation**:
  - Native HTML forms: rehost markup, route submit through our proxy — we store
    a copy, then forward the original POST. Client's automation unbroken; we
    capture the lead.
  - **Iframed forms (GHL et al.) are cross-origin — submissions cannot be read.
    Hard constraint.** v1 behavior: embed as-is (client loses nothing; we don't
    see those leads) and flag. Real fix, offered per-client: recreate the form
    natively with our form system pushing into GHL via API/webhook so both
    sides get the lead (~10-minute setup per client).

## Cutover — going live on the gym's domain

With the clone tier gone, the migration moment is sharper and needs its own
machinery:

1. **Domain attach**: ACM certificate issuance/validation, CloudFront alias for
   the gym's domain (apex + www), DNS instructions for the gym (or Route53 if we
   manage). A site is not "live" until its domain resolves to our CloudFront.
2. **301 redirect map — hard requirement.** The gym's old URLs (captured during
   intake from nav + key pages) are diffed against the new template routes; every
   orphaned old URL gets a 301 to its nearest new page, served at the CloudFront
   layer. Dropping the clone does NOT drop this — it's what preserves their
   existing SEO equity at cutover.
3. **Go-live sequence**: intake → build → staging preview → gym approves → DNS
   switch → publish + redirects live → sitemap submitted / IndexNow pinged →
   gym cancels old host only after we verify resolution.

## Media pipeline

- Images from GMB + homepage are downloaded, rehosted to S3/CDN, and optimized
  (sizing, modern formats) into the client's media-library doc. Client sites
  never hotlink source-site assets.
- The existing **AI image generation API** in `apps/api` is kept: it fills gaps
  when a gym has few/poor photos (hero backgrounds, program imagery), routed
  through the same media library so generated assets are reviewable like any
  other. (Remaining hardening items tracked in
  `.claude/docs/asset-generation-todos.md`.)

## Persistence

Ported from v1: Postgres + Kysely doc storage, site/version tables (immutable
deploy prefixes ↔ `site_versions` pointer), and the artifact store. v2 trims
tables that only served the dead pipelines (clone assets, extraction artifacts).

## Deferred (explicitly out of v1 scope, not forgotten)

- **GSC integration**: programmatic property ownership at go-live + Search
  Analytics ingestion feeding the AI content loop.
- **Content wells** (/local-guide, locally-targeted blog) default-on.
- **PushPress platform API integration** (live schedule/pricing instead of
  scraped).
- **Multi-location gyms.**
- **Delta preview** (show prospect their would-be template site before signup).

## Repo shape (fresh start, port the keepers)

New clean structure designed around v2:

```
milo/
  packages/schema/        # GymSiteContent + doc Zod schemas — the contract
  templates/<name>/       # hand-approved Astro themes
  apps/renderer/          # Astro: GymSiteContent + template → static site
  apps/api/               # Fastify: docs CRUD, intake, build orchestration, leads, assistant
```

**Ported from v1:** GMB enrich, renderer bones, doc-schema ideas, and the three
proven subsystems below, which carry over intact.

### Ported subsystem 1 — Publishing / staging / production (S3 + CloudFront)

This work is good and is kept as-is:
- **S3 layout**: immutable deploy prefixes per build; staging deploys never touch
  production.
- **CloudFront**: distribution + viewer-request function that rewrites request
  paths to the current deploy prefix (`/current/` pointer via KVS). Publish is a
  pointer swap; rollback is repointing to a prior prefix.
- **Semantics**: every build stages only. Production publish is always an
  explicit, human-approved action (`milo publish` / publish endpoint).
- **Ops convention**: all Milo AWS access uses the `unicorn` profile
  (S3 `pushpress-marketing-dev`, CloudFront, KVS).

### Ported subsystem 2 — OpenRouter LLM layer

The LLM access layer (`llm-client.ts`) is kept as-is: OpenRouter-backed,
env-configured (`OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY`), per-call model
selection, and build cost tracking (LLM tokens + S3 in one summary). All v2 LLM
usage (intake extraction, generative copy gaps) goes through this client. No
direct provider SDKs.

### Ported subsystem 3 — milo CLI

The CLI remains the operator interface for the whole system. The v1 skeleton
(`milo.ts` arg parsing, stage runner, stage groups) is ported; v2 commands map
to the new pipeline:

```
milo intake  --url <gym-url>          # GMB + crawl → doc drafts
milo build   --site <uuid>            # docs → GymSiteContent → render → staging
milo preview --site <uuid>            # staging URL
milo publish --site <uuid>            # explicit prod swap (approval-gated)
milo reskin  --site <uuid> --template <name>
milo studio  --url <reference-url>    # Template Studio session entry point
```

The existing v1 CLI keeps functioning untouched in the current repo during the
transition — nothing breaks while v2 is stood up.

**Deleted (not ported):** section-extract, adapt, spec-audit, template-eval,
template-fix auto-loop, BFS clone, asset rehosting, clone-edit HTML transforms,
pixel-diff eval, all nav scraping/reconciliation, clone-as-a-product tier.

## Build order (each milestone ships something demonstrable)

1. **Contract** — `GymSiteContent` + doc Zod schemas in `packages/schema`
2. **Template #1** — Template Studio session from a reference URL, rendering
   fixture data, Dan-approved
3. **Intake** — GMB + homepage + targeted subpages → docs for a real gym
4. **Build + publish** — ported deploy path → first real client site end-to-end
5. **Leads** — form system + native-form proxy
6. **AI assistant** — doc-editing loop with preview/publish gates

## Decision log

| Decision | Choice | Rationale |
|---|---|---|
| Template creation | Supervised Template Studio (URL or original design) | v1's unattended extract→judge→fix chain plateaued at 78/100; interactive build with visual iteration + human acceptance has a definite finish line |
| Rebuild fidelity | Brand + content carry over; template's design wins | Makes any-client-on-any-template structurally true |
| Crawl scope | Assets from homepage + GMB only; facts from a few key subpages | No BFS, no rehosting; intake is research, not replication |
| Clone tier | Dropped | Not in requirements; consumed huge effort in v1 |
| Codebase | Fresh repo, port proven pieces | Reset structure without rewriting what worked |
| Vertical | Gyms/fitness only | Depth over breadth; aligns with PushPress customer base and future platform API integration |
