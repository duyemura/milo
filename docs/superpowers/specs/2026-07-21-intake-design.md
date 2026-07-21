# Milo Intake — Design Spec

**Date:** 2026-07-21
**Status:** Approved
**Scope:** `packages/intake` + `apps/cli intake` command

---

## Overview

`milo intake --url <gym-url>` crawls a real gym's web presence and produces four living documents plus a local asset archive:

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
            [--out <dir>]            default: ./intake-output/
            [--include-ugc]          include blogs/news (default: off)
            [--max-pages <n>]        crawl cap (default: 25)
            [--concurrency <n>]      parallel page fetches (default: 3)
            [--skip-crawl]           re-use existing crawl/ bundle, re-run synthesis only
```

---

## Output layout

```
<out>/
  gym.json              ← GymDocuments (identity + brand + full multi-page hierarchy)
  context.json          ← brand/marketing intelligence
  business.json         ← business intelligence
  integrations.json     ← analytics + gym software (auto-detected + operator-editable)
  assets/               ← all downloaded site assets (images, fonts)
    hero.webp
    logo.svg
    coach-sarah.jpg
    …
  crawl/
    identity.json       ← raw Places API response
    brand.json          ← colors, fonts, logo, social links, software signals
    pages.json          ← full page inventory (see format below)
    pages/
      index.json        ← page document (one file per crawled page)
      about.json
      coaches.json
      programs.json
      …
```

Images and fonts referenced in `gym.json` use local paths (`/assets/filename.ext`), never external URLs. The renderer serves these from `public/` at build time.

`--skip-crawl` skips all HTTP fetching AND the per-page LLM classification calls, jumping straight to synthesis from the existing bundle (~10–15s).

---

## Step 1: Google Places API lookup

Fetch the homepage first (static `fetch()`) to:
1. **Normalize the base URL** — follow all redirects (HTTP→HTTPS, www→non-www, trailing slash) and record the canonical base URL. All subsequent same-origin checks use this normalized base.
2. **Extract the gym name** — from `<title>`, `og:site_name`, or `<h1>`. Used to search Places.

Search the Places API (New) with gym name + city (extracted from URL domain or homepage address text) to retrieve:

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
/llms.txt              (if present, use as primary source)
/sitemap.xml
/sitemap_index.xml     (follow sub-sitemap links)
/robots.txt            (extract Sitemap: directive)
```

**2b — Extract homepage nav links** — parse `<nav>` / top-level `<header>` links. These are the gym's own opinion of their important pages.

**2c — Merge + deduplicate** — combine all discovered URLs, same-origin only (using normalized base URL from Step 1).

**2d — Filter non-HTML content** — skip PDFs, images, fonts, and other binary content types based on URL extension (`.pdf`, `.jpg`, `.png`, `.mp4`, etc.) and known non-page paths.

**2e — Filter UGC** (when `--include-ugc` is off) — strip URLs matching:
- Path segments: `/blog/`, `/news/`, `/wod/`, `/workout/`, `/articles/`, `/posts/`, `/insights/`, `/resources/`
- Date patterns: `/2024/`, `/2026/03/`
- WordPress patterns: `?p=`, `?cat=`

**2f — Prioritize** remaining pages:
1. Homepage
2. About / Our Story / Mission
3. Coaches / Team / Staff
4. Programs / Classes / Services
5. Pricing / Membership / Join
6. Schedule
7. FAQ
8. Contact
9. Everything else (alphabetical)

**2g — Cap** at `--max-pages` (default 25). Log a warning if raw inventory exceeded the cap: `"Capped at 25 pages (47 additional pages were skipped)"`.

### `pages.json` format

```typescript
{
  baseUrl: string                // normalized base URL after following redirects
  discoveredAt: string           // ISO timestamp
  totalDiscovered: number        // raw page count before UGC filter + cap
  filtered: number               // pages removed by UGC filter
  capped: number                 // pages dropped by --max-pages
  pages: Array<{
    url: string
    slug: string                 // derived from URL path, e.g. "coaches"
    priority: number             // 1–9 from prioritization step above
    source: "sitemap" | "nav" | "crawl-discovered"
    llmBudget: "full" | "truncated"  // full = top 8 pages; truncated = bodyText capped at 800 chars
  }>
}
```

`llmBudget` is assigned at inventory time based on priority. Pages 1–8 get `full`; the rest get `truncated`. This is the input to context window management in Step 5.

---

## Step 3: Crawl phase

Fetch each URL from the inventory using the strategy below. Produce a page document per URL saved to `crawl/pages/{slug}.json`.

### Fetch strategy: static first, Playwright fallback

**Static fetch** (fast, default): plain `fetch()` + HTML parse. If the extracted `bodyText` is below 200 characters after boilerplate stripping, the page is JS-rendered — fall back to Playwright.

**Playwright fallback** (JS-rendered pages): spawn a headless Chromium instance (reusing the `apps/studio` Playwright setup), wait for `networkidle`, extract the rendered HTML. Log which pages fell back: `"[intake] page /coaches is JS-rendered — using Playwright"`.

Concurrency: `--concurrency` (default 3) parallel fetches. Add 500ms delay between request batches to avoid triggering bot detection. Set `User-Agent: Milo-Intake/1.0 (+https://pushpress.com)`.

### Asset downloading

As each page is crawled, collect all asset URLs that should be hosted locally:

**Download:** images (`<img src>`, `og:image`, CSS `background-image` URLs), fonts (`@font-face src` in linked CSS).

**Do not download:** third-party scripts (GTM, GA, analytics pixels, chat widgets, gym software booking scripts) — these must be fetched live by the browser to function.

Downloaded assets are saved to `<out>/assets/` with sanitized filenames. References in the page document `images[]` use local paths (`/assets/filename.ext`). The LLM synthesis step uses local paths when populating `SectionImage.src` fields in `gym.json`.

Failures are logged and skipped — a missing asset doesn't fail the crawl.

### Page document schema

```typescript
{
  url: string
  slug: string
  title: string
  metaDescription: string
  headings: string[]            // h1–h3 in order
  bodyText: string              // cleaned plain text, boilerplate stripped
                                // capped at 800 chars if llmBudget === "truncated"
  images: { src: string; alt: string; localPath: string | null }[]
  links: string[]               // same-origin outbound links discovered
  fetchMethod: "static" | "playwright"
  detectedType: string          // homepage | about | coaches | programs | pricing |
                                // schedule | faq | contact | other
  pageArchetype: string         // homepage | landing page | about/story | team |
                                // program/service | pricing | schedule | faq |
                                // contact | pillar content
  pageGoal: string              // convert | inform | build trust | rank for keyword |
                                // answer questions
  primaryKeyword: string
  secondaryKeywords: string[]
  topicsAnswered: string[]      // questions this page answers (feeds AEO)
  conversionSignals: string[]   // CTAs and persuasion elements found
}
```

**Boilerplate stripping** — remove `<nav>`, `<header>`, `<footer>`, cookie banners, `<script>`, `<style>` before extracting `bodyText`. LLM sees signal, not noise.

**New links during crawl** — if a crawled page links to uncrawled same-origin pages that aren't UGC and `--max-pages` hasn't been reached, add them to the queue.

`detectedType`, `pageArchetype`, `pageGoal`, `primaryKeyword`, `secondaryKeywords`, `topicsAnswered`, and `conversionSignals` are inferred by a lightweight per-page LLM classification call (fast/cheap model).

---

## Step 4: Brand extraction

All extracted from homepage HTML + linked CSS files. Saved to `crawl/brand.json`.

### Colors
Fetch all `<link rel="stylesheet">` and inline `<style>` blocks. Parse for hex, rgb(), hsl(), and CSS variable values. Count frequency. LLM classifies into five `BrandTokens` slots: `primary`, `accent`, `surface`, `text`, `muted`. For Tailwind sites, map utility class names to Tailwind's default palette as a lookup table.

### Fonts
Parse `@font-face`, `font-family` on `body` and `h1–h3`, Google Fonts `<link>` imports, and CSS variable patterns (`--font-heading`, `--font-body`). Map to `display` and `body` token slots. Fonts found via `@font-face` are downloaded to `<out>/assets/` alongside images.

### Space + radius tokens
Cannot be meaningfully derived from CSS. Default to: `sm: 8px, md: 16px, lg: 32px`, `button: 6px, card: 12px`. Operator adjusts before building if needed.

### Logo
`<img>` in `<header>` with `logo` in class, alt, or src attribute. Fall back to `og:image` meta tag. Downloaded to `<out>/assets/`.

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

### Context window management

Before Pass 1, estimate total input tokens from the page documents. Apply `llmBudget` from `pages.json`:

- `full` pages (priority 1–8): send complete `bodyText`
- `truncated` pages (priority 9+): cap `bodyText` at 800 characters

If estimated input still exceeds the model's context limit (128k tokens as a safe ceiling), progressively truncate `full` pages to 2,000 chars, then 1,000 chars, until it fits. Log any truncation: `"[intake] truncating 3 pages to fit context window"`.

The synthesis prompt uses structured output (JSON schema enforcement via `@milo/llm`) so the LLM cannot produce free-form text — it fills a typed schema or the call fails with a retryable error.

### Pass 1 — Content + intelligence (capable model)

**Input:** all page documents (budget-managed) + `crawl/identity.json` + `crawl/brand.json`

**Outputs:** `gym.json` + `context.json`

The LLM is given:
- All page documents (full text + classifications, within context budget)
- The complete section schema vocabulary (all 16 section types + their Zod field shapes)
- Places identity data
- Instructions: produce a multi-page `SiteHierarchy` where each page maps to the appropriate crawled content, sections are drawn from the real page text, local asset paths used for all images, and the gym's own words are preserved wherever possible

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
  siteArchitecture: {             // generated in same LLM pass as hierarchy — stays in sync
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

`detected: false` signals to the operator: fill this in if you have it. The renderer reads `integrations.json` at build time and injects present tags into `<head>`. Third-party scripts (GTM, analytics pixels) are injected as-is — they fetch live from their CDNs, as intended.

---

## Validation

Every output file is parsed through its Zod schema before being written. On failure, the error surfaces with the field path and exits 1. The operator re-runs with `--skip-crawl` to retry synthesis without re-crawling.

---

## Idempotency

Running intake twice into the same `--out` directory overwrites all files. The `crawl/` bundle is overwritten unless `--skip-crawl` is passed (in which case it's read-only).

---

## Architecture

### `packages/intake`

```
src/
  places.ts      — Google Places API lookup (injectable interface for testing)
  discover.ts    — URL normalization, sitemap + nav extraction → pages.json
  crawl.ts       — fetch pages (static + Playwright fallback), asset download, page docs
  brand.ts       — CSS color/font extraction, software + analytics fingerprint
  synthesize.ts  — LLM Pass 1: gym.json + context.json, context window management
  classify.ts    — LLM Pass 2: business.json + integrations.json
  schemas.ts     — Zod schemas for all four output files + page document + pages.json
  intake.ts      — orchestrates all steps
  index.ts       — public exports
```

Places API client and page fetcher are injected as interfaces — same pattern as `S3Adapter` in `packages/publish`. Fakes used in unit tests; no live HTTP in CI. Playwright is used only as a fallback and is not required for unit tests.

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
| Page is JS-rendered (empty body) | Retry with Playwright; log `"[intake] page /X is JS-rendered — using Playwright"` |
| Asset download fails | Log warning, skip asset, continue with external URL as fallback |
| CSS parsing finds no colors | Use neutral defaults, flag in `brand.json` as undetected |
| LLM context window exceeded | Truncate pages progressively until it fits; log truncations |
| LLM produces invalid `gym.json` | Surface Zod error with field path, exit 1 |
| `--skip-crawl` but no `crawl/` exists | Fail fast: `"No crawl bundle found at <path>"` |
| `--max-pages` cap reached | Log: `"Capped at N pages (M additional pages were skipped)"` |

---

## Testing

- **Unit tests** — `packages/intake` with fake Places client + fake page fetcher. Tests for URL normalization, discovery, UGC filtering, prioritization, brand extraction, context window budgeting, schema validation.
- **No live HTTP in CI** — all network calls behind injected interfaces.
- **Manual integration smoke test** — run against a known stable gym URL to verify end-to-end.

---

## Out of scope

- Web search enrichment (Brave/SerpAPI) — deferred, add later if crawl produces thin results
- Multi-location intake in a single run
- Analytics injection into the renderer — separate renderer feature using `integrations.json`
- Milo-managed analytics solution — separate product feature
- Video asset downloading
