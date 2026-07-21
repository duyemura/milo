# Milo Intake — Design Spec

**Date:** 2026-07-21
**Status:** Approved
**Scope:** `packages/intake` + `apps/cli intake` command

---

## Overview

`milo intake --url <gym-url>` crawls a real gym's web presence and produces four living documents:

| File | Purpose |
|---|---|
| `gym.json` | Valid `GymDocuments` — full multi-page site, ready to build |
| `context.json` | Brand + marketing intelligence (ICP, voice, objections, SEO) |
| `business.json` | Business intelligence (tech stack, marketing maturity, pricing) |
| `integrations.json` | Detected analytics + gym software tags — operator-editable |

All four files have Zod schemas and are designed to be edited by AI assistants in future sessions without raw JSON overwrites.

---

## Command

```
milo intake --url <gym-url>
            [--out <dir>]          default: ./intake-output/
            [--include-ugc]        include blogs/news (default: off)
            [--max-pages <n>]      crawl cap (default: 25)
            [--skip-crawl]         re-use existing crawl/ bundle, re-run synthesis only
```

---

## Output layout

```
<out>/
  gym.json            ← GymDocuments (identity + brand + full multi-page hierarchy)
  context.json        ← brand/marketing intelligence
  business.json       ← business intelligence
  integrations.json   ← analytics + gym software (auto-detected + operator-editable)
  crawl/
    identity.json     ← raw Places API response
    brand.json        ← colors, fonts, logo, social links, software signals
    pages.json        ← final page inventory (ordered, with archetype hints)
    pages/
      index.json      ← page document (one file per crawled page)
      about.json
      coaches.json
      programs.json
      …
```

The `crawl/` bundle is the intermediate representation. `--skip-crawl` skips all HTTP fetching AND the per-page LLM classification calls, jumping straight to synthesis from the existing bundle (~10–15s, one LLM call).

---

## Step 1: Google Places API lookup

Fetch the homepage first to extract the gym name (from `<title>`, `og:site_name`, or `h1`). Use that name + city (from the URL domain or any address in the page) to search the Places API (New) and retrieve structured identity data:

- Name, formatted address, address components
- Phone number
- Geo coordinates (lat/lng)
- Opening hours (structured periods)
- Google Maps URL
- Google Business Profile URL
- Price level
- Rating + review count (for social proof signals)

Saved to `crawl/identity.json`. If no match is found, log a warning and continue — crawl-only identity will be derived from the homepage.

**Env var required:** `GOOGLE_PLACES_API_KEY`

---

## Step 2: Discovery phase

Build an ordered page inventory to crawl.

**2a — Probe standard endpoints** (parallel):
```
/llms.txt             (if present, use as primary source)
/sitemap.xml
/sitemap_index.xml    (follow sub-sitemap links)
/robots.txt           (extract Sitemap: directive)
```

**2b — Extract homepage nav links** — parse `<nav>` / top-level `<header>` links. These are the gym's own opinion of their important pages.

**2c — Merge + deduplicate** — combine all discovered URLs, same-origin only.

**2d — Filter UGC** (when `--include-ugc` is off) — strip URLs matching:
- Path segments: `/blog/`, `/news/`, `/wod/`, `/workout/`, `/articles/`, `/posts/`, `/insights/`, `/resources/`
- Date patterns: `/2024/`, `/2026/03/`
- WordPress patterns: `?p=`, `?cat=`

**2e — Prioritize** remaining pages:
1. Homepage
2. About / Our Story / Mission
3. Coaches / Team / Staff
4. Programs / Classes / Services
5. Pricing / Membership / Join
6. Schedule
7. FAQ
8. Contact
9. Everything else (alphabetical)

**2f — Cap** at `--max-pages` (default 25). Log a warning if raw inventory exceeded the cap.

Saved to `crawl/pages.json`.

---

## Step 3: Crawl phase

Fetch each URL from the inventory. For each page, produce a page document saved to `crawl/pages/{slug}.json`.

### Page document schema

```typescript
{
  url: string
  slug: string
  title: string
  metaDescription: string
  headings: string[]           // h1–h3 in order
  bodyText: string             // cleaned plain text, boilerplate stripped
  images: { src: string; alt: string }[]
  links: string[]              // same-origin outbound links discovered
  detectedType: string         // homepage | about | coaches | programs | pricing |
                               // schedule | faq | contact | other
  pageArchetype: string        // homepage | landing page | about/story | team |
                               // program/service | pricing | schedule | faq |
                               // contact | pillar content
  pageGoal: string             // convert | inform | build trust | rank for keyword |
                               // answer questions
  primaryKeyword: string
  secondaryKeywords: string[]
  topicsAnswered: string[]     // questions this page answers (feeds AEO)
  conversionSignals: string[]  // CTAs and persuasion elements found
}
```

**Boilerplate stripping** — remove `<nav>`, `<header>`, `<footer>`, cookie banners, `<script>`, `<style>` before extracting `bodyText`. LLM sees signal, not noise.

**New links during crawl** — if a crawled page links to uncrawled same-origin pages that aren't UGC and `--max-pages` hasn't been reached, add them to the queue.

`detectedType`, `pageArchetype`, `pageGoal`, `primaryKeyword`, `secondaryKeywords`, `topicsAnswered`, and `conversionSignals` are inferred by a lightweight LLM classification call per page (fast model, cheap).

---

## Step 4: Brand extraction

All extracted from homepage HTML + linked CSS files. Saved to `crawl/brand.json`.

### Colors
Fetch all `<link rel="stylesheet">` and inline `<style>` blocks. Parse for hex, rgb(), hsl(), and CSS variable values. Count frequency. LLM classifies into five `BrandTokens` slots: `primary`, `accent`, `surface`, `text`, `muted`. For Tailwind sites, map utility class names to Tailwind's default palette as a lookup table.

### Fonts
Parse `@font-face`, `font-family` on `body` and `h1–h3`, Google Fonts `<link>` imports, and CSS variable patterns (`--font-heading`, `--font-body`). Map to `display` and `body` token slots.

### Space + radius tokens
Cannot be meaningfully derived from CSS. Default to: `sm: 8px, md: 16px, lg: 32px`, `button: 6px, card: 12px`. Operator adjusts before building if needed.

### Logo
`<img>` in `<header>` with `logo` in class, alt, or src attribute. Fall back to `og:image` meta tag.

### Social links
Extract all links to `instagram.com`, `facebook.com`, `twitter.com`, `x.com`, `youtube.com`, `tiktok.com`, `linkedin.com` from footer and header.

### Gym software fingerprint
Check script `src` attributes, form `action` URLs, and `<iframe>` sources:

| Platform | Signal |
|---|---|
| PushPress | `pushpressapp.com`, `app.pushpress.com` |
| Mindbody | `mindbodyonline.com`, `booker.com` |
| Wodify | `wodify.com` |
| Pike13 | `pike13.com` |
| Glofox | `glofox.com` |
| Zen Planner | `zenplanner.com` |
| Classboom | `classboom.com` |

---

## Step 5: LLM synthesis

Two passes over the crawl bundle.

### Pass 1 — Content + intelligence (capable model)

**Input:** all page documents + `crawl/identity.json` + `crawl/brand.json`

**Outputs:** `gym.json` + `context.json`

The LLM is given:
- All page documents (full text + classifications)
- The complete section schema vocabulary (all 16 section types + their Zod field shapes)
- Places identity data
- Instructions: produce a multi-page `SiteHierarchy` where each page maps to the appropriate crawled content, sections are drawn from the real page text, and the gym's own words are preserved wherever possible

**Multi-page hierarchy** — the LLM builds pages for each archetype found in the crawl:
- `/` — homepage
- `/about` — story/mission (if about page found)
- `/programs` — one page per program (or combined programs page)
- `/coaches` — team (if coaches page found)
- `/pricing` — membership (if pricing page found)
- `/schedule` — schedule (if schedule page found)
- `/contact` — contact + location

#### `context.json` schema

```typescript
{
  icp: {
    fitnessLevel: string           // beginner-friendly | intermediate | advanced | competitive
    ageRange: string               // e.g. "25–45"
    lifestage: string[]            // young professionals | parents | competitors | etc.
    primaryGoals: string[]         // performance | weight loss | community | sport-specific
    psychographics: string         // narrative description
  }
  brandVoice: {
    tone: string                   // e.g. "confident and direct, coach-led authority"
    avoids: string[]
    emphasizes: string[]
    communicationStyle: string     // formal/informal, "you" vs "members", first/third person
  }
  positioning: {
    headline: string               // one-line positioning statement
    differentiators: string[]
    vsCompetition: string          // how they position against other options
    competitivePositioning: string // explicit language they use against competitors if any
  }
  painPointsAddressed: string[]
  primaryOffer: string             // e.g. "Free 1-on-1 intro session with a coach"
  pricingTier: string              // premium | mid-market | budget
  memberTransformationLanguage: string[]  // their exact words for results
  commonObjections: string[]       // price | intimidation | time | etc.
  contentPillars: string[]         // programming | nutrition | community | competition | etc.
  coachAuthoritySignals: string[]  // certifications, years, competitive history
  socialProof: {
    yearsOpen: number | null
    memberCount: string | null     // "500+" etc.
    mediaAchievements: string[]
    reviewHighlights: string[]
  }
  geographicContext: {
    neighborhood: string
    city: string
    localCultureSignals: string[]
    areaServed: string[]
  }
  seasonalCampaigns: string[]      // known recurring campaigns/challenges
  siteArchitecture: {
    slug: string
    archetype: string
    goal: string
  }[]
}
```

### Pass 2 — Business + integrations (fast model)

**Input:** page documents + `crawl/brand.json`

**Outputs:** `business.json` + `integrations.json`

Mostly pattern-matching from detected signals, with a small LLM call for narrative business intelligence fields.

#### `business.json` schema

```typescript
{
  techStack: {
    websiteBuilder: string | null   // WordPress | Squarespace | Wix | Webflow | custom
    gymSoftware: string | null      // PushPress | Mindbody | Wodify | etc.
    emailPlatform: string | null    // Mailchimp | Klaviyo | ActiveCampaign | etc.
    bookingMethod: string           // embedded widget | external link | phone only
    hasPaymentProcessing: boolean
    hasLiveChat: boolean
  }
  marketingMaturity: {
    runsPaidAds: boolean            // Facebook Pixel or Google Ads tag detected
    hasEmailList: boolean           // newsletter signup or lead magnet present
    doesContentMarketing: boolean   // active blog, YouTube, podcast detected
    hasMemberApp: boolean
    socialPlatforms: string[]
  }
  businessSignals: {
    locationCount: number           // single | multi (detected from site)
    coachCount: number | null       // number of coaches listed
    pricingPoints: string[]         // actual prices found on pricing page
    membershipModel: string[]       // monthly | punch card | drop-in | contract
    hasCompetitiveTeam: boolean
  }
  assessment: string                // LLM narrative: overall business maturity, opportunity signals
}
```

#### `integrations.json` schema

```typescript
{
  analytics: {
    ga4:           { measurementId: string | null; detected: boolean }
    gtm:           { containerId: string | null;   detected: boolean }
    facebookPixel: { pixelId: string | null;       detected: boolean }
    hotjar:        { siteId: string | null;        detected: boolean }
  }
  gymSoftware: {
    platform: string | null
    detected: boolean
    bookingUrl: string | null
  }
  email: {
    platform: string | null
    detected: boolean
    embedCode: string | null
  }
  chat: {
    platform: string | null
    detected: boolean
  }
}
```

`detected: false` signals to the operator: fill this in if you have it. The renderer reads `integrations.json` at build time and injects present tags into `<head>`.

---

## Validation

Every output file is parsed through its Zod schema before being written. On failure, the error surfaces with the field path and exits 1. The operator fixes the crawl data or re-runs synthesis with `--skip-crawl`.

---

## Architecture

### `packages/intake`

```
src/
  places.ts      — Google Places API lookup
  discover.ts    — sitemap + nav extraction → page inventory
  crawl.ts       — fetch + clean pages → page documents
  brand.ts       — CSS color/font extraction, software fingerprint
  synthesize.ts  — LLM Pass 1: gym.json + context.json
  classify.ts    — LLM Pass 2: business.json + integrations.json
  schemas.ts     — Zod schemas for all four output files
  intake.ts      — orchestrates all steps
  index.ts       — public exports
```

Places API client and page fetcher are injected as interfaces — same pattern as `S3Adapter` in `packages/publish`. Fakes used in unit tests; no live HTTP in CI.

### `apps/cli`

`apps/cli/src/milo.ts` adds `intake` case, calling `packages/intake` with config from flags.

### Required env vars

| Var | Purpose |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Places API lookup |
| `OPENROUTER_API_KEY` | LLM synthesis (via `@milo/llm`) |

---

## Error handling

| Scenario | Behavior |
|---|---|
| `GOOGLE_PLACES_API_KEY` missing | Fail fast with clear message |
| Places finds no match for URL | Warn, skip Places, continue with crawl-only identity |
| Page fetch fails (404, timeout) | Skip page, log warning, continue |
| CSS parsing finds no colors | Use neutral defaults, flag in `brand.json` as undetected |
| LLM produces invalid `gym.json` | Surface Zod error with field path, exit 1 |
| `--skip-crawl` but no `crawl/` exists | Fail fast: `"No crawl bundle found at <path>"` |
| `--max-pages` cap reached | Log: `"Capped at N pages (M additional pages were skipped)"` |

---

## Testing

- **Unit tests** — `packages/intake` with fake Places client + fake page fetcher. Tests for discovery, UGC filtering, prioritization, brand extraction, schema validation.
- **No live HTTP in CI** — all network calls behind injected interfaces.
- **Manual integration smoke test** — run against a known stable gym URL to verify end-to-end.

---

## Out of scope

- Web search enrichment (Brave/SerpAPI) — deferred, add later if crawl produces thin results
- Playwright/visual brand extraction — handled by `milo studio` if needed
- Multi-location intake in a single run
- Analytics injection into the renderer — separate renderer feature using `integrations.json`
- Milo-managed analytics solution — separate product feature
