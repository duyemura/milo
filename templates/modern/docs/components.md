# modern — component reference

> Generated from `template.json` by `apps/studio/src/template-docs.mjs`. Do not edit by hand — edit the manifest and regenerate.

Bold Montserrat-900 design with electric blue accent on off-white; navy feature bands, soft-shadow white cards, rounded buttons. Built from the pushpress-site-modern.webflow.io reference in a Template Studio session.

## Design tokens

| Token | Value |
|---|---|
| `fontDisplay` | `Montserrat` |
| `bg` | `#fafafa` |
| `text` | `#06090a` |
| `accentDefault` | `#0464fc` |
| `darkDefault` | `#000b27` |
| `radiusButton` | `10px` |
| `radiusCard` | `12px` |

## Components

### `hero`

Full-bleed photo hero with left dark gradient, uppercase kicker band, 49px white 900 headline, right-aligned play-arrow CTA.

**Usage:** First section of home and landing pages. Heading supports <br/> for line control; keep it under ~8 words. Needs a high-quality dark-toned photo.

### `program-cards`

Alternating text/image rows; 38px 900 program names, rounded photography, blue CTA per program.

**Usage:** Home (2-3 flagship programs) and programs-index (all). Give each program a real photo; rows alternate automatically.

### `coach-grid`

White cards with 4:5 portrait, name, blue uppercase role, bio, certification chips.

**Usage:** Coaches page lead section; also works on about. 3 columns; portraits should be consistent crops.

### `schedule`

Per-day white cards with blue day labels and time/name slots.

**Usage:** Schedule page. Feed real class times; empty days show a rest-day note.

### `testimonials`

Italic 900 centered heading, white review cards with gold stars, avatar initial, name and source.

**Usage:** Home social-proof slot and testimonials page. 3 reviews per row; quotes 2-4 sentences.

### `faq`

Accordion with soft-shadow cards; first item open; emits FAQPage JSON-LD for AEO.

**Usage:** Home (4-6 questions) and any page needing objection-handling. Answers are plain text.

### `cta-band`

Navy band, 44px 900 white heading, blue play-arrow button, optional right-side photo blended with gradient.

**Usage:** Page-closing conversion slot on nearly every page. Without an image it centers.

### `location-map`

Split layout: heading, bold address, hours, phone, directions button; map iframe or styled address panel.

**Usage:** Home lower section and location-contact page. Supply mapEmbedUrl when available.

### `contact-form`

Soft-shadow card form with default name/email/phone/message fields, POSTs to the Milo leads endpoint.

**Usage:** Contact/about pages. Use lead-form instead for conversion-focused funnels.

### `lead-form`

Navy split section: heading + supporting copy left, white form card right; formId routes the lead.

**Usage:** getting-started and landing pages — the primary conversion component. Keep fields minimal (3-5).

### `pricing`

White plan cards with 52px 900 prices, feature checklists; featured plan raised with blue border and badge.

**Usage:** Pricing page. 2-4 plans; mark exactly one featured.

### `feature-grid`

Card grid of title+body items with icons or numbers.

Variants:

- `default` — white cards with blue line icons
- `numbered` — blue 900 numerals — for real sequences (getting-started steps)
- `cards` — raised trio overlapping the section above — place directly after hero
- `dark` — navy amenities band, 4-up, white-on-navy cards

**Usage:** The workhorse. Pick the variant by intent: cards after hero, numbered for how-it-works, dark for amenities/features band.

### `content-block`

Measured prose section: 44px 900 heading + 18px paragraphs split on blank lines.

**Usage:** About/pillar pages for narrative content. Keep to ~3 paragraphs per block; stack blocks for longer stories.

### `media-block`

Heading + copy beside a white-framed photo with soft shadow; mediaSide controls order.

**Usage:** Community/story sections. Pairs well after testimonials on home.

### `stats-band`

Navy full-width band with 56px 900 white values over blue uppercase labels.

**Usage:** Credibility punch between sections; 3-4 stats, short labels.

### `logo-strip`

Muted uppercase heading over a centered row of grayscale logos.

**Usage:** Affiliations/certifications on about; keep 3-6 logos.

## Page archetype recipes

Section order a site build should use when composing each page archetype with this template (`type#variant` marks a variant hint):

- **home**: `hero` → `feature-grid#cards` → `program-cards` → `feature-grid#numbered` → `testimonials` → `feature-grid#dark` → `media-block` → `location-map` → `faq` → `cta-band` — The canonical composition mirrors the reference site's narrative arc: hook → reassure → offer → how → proof → facilities → community → find-us → objections → convert.
- **about**: `content-block` → `logo-strip` → `media-block` → `contact-form` — Narrative first, credibility, community photo, low-pressure contact.
- **coaches**: `coach-grid` → `cta-band`
- **programs-index**: `program-cards` → `faq` → `cta-band`
- **program-detail**: `hero` → `content-block` → `feature-grid#default` → `testimonials` → `cta-band`
- **schedule**: `schedule` → `cta-band`
- **pricing**: `pricing` → `stats-band` → `faq` → `cta-band`
- **location-contact**: `location-map` → `contact-form`
- **drop-in**: `hero` → `content-block` → `pricing` → `location-map` → `cta-band`
- **getting-started**: `lead-form` — Single-purpose conversion page; do not dilute with extra sections.
- **landing-page**: `hero` → `feature-grid#default` → `testimonials` → `lead-form`
- **pillar-page**: `content-block` → `media-block` → `faq` → `cta-band`
- **blog-index**: `content-block` → `cta-band`
- **blog-post**: `content-block` → `cta-band`
- **testimonials**: `testimonials` → `stats-band` → `cta-band`
