# Session 2 Report — Template System Complete

**Date:** 2026-07-21  
**Branch:** `phase1a-template-spine`  
**Tests:** 119 passing, 0 failing

---

## What was built this session

### Phase 1b — Template #1 complete

- **16 section components** for `templates/modern` — all token-driven (no hardcoded colors), no JSON-LD, scoped styles
- **Design polish** — Montserrat Variable + Inter Variable self-hosted fonts, Hero with editorial accent bar, all components with Lighthouse perf=99
- **Full SEO/AEO stack:**
  - `SeoHead.astro` in renderer — `og:*`, `twitter:*`, canonical, favicon, theme-color, robots, og:locale — automatic for every template
  - Page-level `@graph` — `LocalBusiness + SportsActivityLocation` (geo, hours, phone, priceRange, hasMap, GBP URL), `WebSite`, `WebPage`, `FAQPage`, `Service[]`, `Person[]`
  - `sitemap.xml` via `@astrojs/sitemap`, `robots.txt` generated from `SITE_URL`
  - `Identity` schema extended with `addressParts`, `geoCoordinates`, `mapsUrl`, `googleBusinessProfileUrl`, `priceRange`, `themeColor`, `favicon`, `socialProfiles`
- **Lighthouse gate** — perf ≥ 90, LCP < 2500ms, SEO ≥ 90, TBT < 200ms (actual: perf=99, SEO=100)
- **Axe a11y gate** — 0 serious/critical violations

### Phase 1c — Template #2 + portability proven

- **`templates/blackout`** — 16 components, Oswald/dark/sharp design language, all design rules enforced by test
- **Registry system** — each template exports `Base` + `COMPONENTS`; renderer selects via `TEMPLATE` env var
- **Portability gate** — same `iron-anchor.json` through both templates → identical `@graph` entity types, same structured data, both pass all gates
- **Contract tests** — `COMPONENTS` keys == `manifest.implements` keys == `SECTION_TYPES` for both templates; will catch Template #3 mistakes at test time

### Architecture hardening (post-review)

- **`Section.safeParse` in render loop** — malformed section content fails the build loudly instead of silently rendering broken pages; Zod defaults now fire
- **`@graph` multi-instance support** — `.find()` → `.filter()` + `.flatMap()` so multiple `faq`/`program-cards`/`coach-grid` sections on one page all contribute structured data
- **JSON-LD fully in renderer** — removed from `Faq`, `ProgramCards`, `CoachGrid`, `LocationMap` components; single source of truth in `@graph`
- **`SeoHead` shared** — renderer-level, automatic for all templates; templates own fonts+typography only
- **Duplicate ID fix** — `ContactForm` prefix with `sectionId`, `LeadForm` prefix with `formId`
- **Named-color test** — added to all 30 component test files; catches `black`/`white`/etc. in style blocks
- **`SITE_URL` guard** — warns at build time in production if not set

---

## Current state of the repo

```
packages/
  schema/           — GymDocuments, Identity, BrandTokens, 16 section schemas, tokensToCss
  llm/              — OpenRouter client (ported from v1)
apps/
  renderer/         — Astro static renderer, TEMPLATE-selectable, all gates
  studio/           — Playwright capture tools (Phase 0, repositioned as brand importer)
templates/
  modern/           — Template #1: Montserrat, navy+blue, soft shadows, 16 components
  blackout/         — Template #2: Oswald, dark, sharp edges, 16 components
```

---

## What's NOT built yet

### Publish (`apps/publish`)
S3 + CloudFront staging/production swap. A build renders to `dist/`, publish uploads to S3 under the gym's slug, and flips the CloudFront KVS router entry. Staging = viewable WIP; production = explicit publish command only.

Port from v1 archive: `~/pushpress/websites/apps/api/src/services/cloudfront.ts`, `s3.ts`, the KVS router. AWS profile: `unicorn`, bucket: `pushpress-marketing-dev`, existing CloudFront distribution.

### Intake (`apps/cli intake` command)
`milo intake --url <gym-url>` populates a `GymDocuments` fixture from a real gym:
- GMB lookup → `identity` (name, address, phone, hours, geo, GBP URL)
- Homepage crawl → brand assets (logo, colors, hero image)
- Targeted subpage fetch (about, coaches, schedule, programs, pricing) → doc content via `@milo/llm`

Port GMB enrich from: `~/pushpress/websites/apps/api/src/services/gmb.ts`

### Generate (`apps/cli generate` command)  
`GymDocuments` → `GymSiteContent` (complete `gym.json`) via LLM + archetype recipes. Reads all doc fields, produces the structured content that the renderer needs.

### Phase 2: AI assistant editing
Safe document mutations — edit docs through validated Zod schemas, never raw HTML.

### Phase 3: Content engine
Blog/pillar generation, internal linking, keyword→content loop.

---

## Key architectural decisions (do not violate)

1. **Templates own nothing but fonts + typography.** All JSON-LD, all meta tags, all structured data = renderer.
2. **Section content is validated** via `Section.safeParse` before rendering. Malformed docs fail loudly.
3. **`SECTION_TYPES` is the closed vocabulary.** Add a section type = schema change + tests + both template components updated.
4. **`GymDocuments` is the single source of truth.** All site content flows from docs; templates are skins.
5. **Intake populates docs once.** After join, Milo is the system of record. Never re-crawl.
6. **Build is hermetic.** All image refs are local (`/placeholder.svg` or rehosted assets). Lighthouse gate runs entirely locally.
