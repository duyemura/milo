# blackout — component reference

> Generated from `template.json` by `apps/studio/src/template-docs.mjs`. Do not edit by hand — edit the manifest and regenerate.

Black-ground brutalist design: Outfit 900 uppercase headings with tight tracking, skewed parallelogram buttons, blue/black checkerboard tiles, diagonal-clipped blue bands. Built from the beanburito.github.io free-intro reference in Template Studio session #2.

## Design tokens

| Token | Value |
|---|---|
| `fontDisplay` | `Outfit` |
| `bg` | `#000000` |
| `text` | `#ffffff` |
| `accentDefault` | `#1b6bf5` |
| `radiusButton` | `0` |
| `radiusCard` | `0` |
| `buttonSkew` | `-10deg` |

## Components

### `hero`

Dark photo hero, 76px uppercase 900 headline at 0.98 line-height, 20px sub, skewed black CTA with arrow.

**Usage:** First section of home and landing pages. Headline reads best at 3-6 words; it will be uppercased.

### `program-cards`

Black section: compact left-aligned heading block, then 3-up tall (3:4) photo cards with uppercase names and arrow links.

**Usage:** Home and programs-index. Photos should be moody/high-contrast; they sit on pure black.

### `coach-grid`

3-up portraits with slight grayscale treatment, uppercase names, blue role labels, outlined cert chips.

**Usage:** Coaches page; portraits get a unifying grayscale filter automatically.

### `schedule`

Hairline-grid day columns on black, blue uppercase day labels.

**Usage:** Schedule page. Dense but scannable; feed real times.

### `testimonials`

Dark cards with blue top rule, blue stars, quoted 300-weight text, uppercase names.

**Usage:** Home proof slot and testimonials page.

### `faq`

Hairline-divided accordion with uppercase questions and a rotating + marker; emits FAQPage JSON-LD.

**Usage:** Home and objection-heavy pages; 4-6 items.

### `cta-band`

Blue band with diagonal clipped top/bottom, outline arrow graphics, uppercase heading, skewed black button — the template's signature conversion moment.

**Usage:** Close nearly every page with this. Heading will be uppercased; keep it a question or imperative.

### `location-map`

Black split section: address/hours/phone left with blue skew button, map iframe or dark address panel right.

**Usage:** Home lower slot and location-contact.

### `contact-form`

Dark form: near-black inputs with hairline borders, uppercase micro-labels, blue skew submit.

**Usage:** Contact/about. Use lead-form for funnels.

### `lead-form`

Blue diagonal-clipped section: uppercase heading + outline arrow left, white form card right, black skew submit.

**Usage:** getting-started and landing pages — primary conversion component.

### `pricing`

Dark plan panels separated by hairlines, italic 900 prices, blue arrow feature markers; featured plan gets blue top rule and tinted panel.

**Usage:** Pricing page; 2-4 plans, one featured.

### `feature-grid`

Two families: light bands and the checkerboard.

Variants:

- `default` — white band, blue line icons, 30px uppercase titles
- `numbered` — white band with 64px italic blue numerals — for sequences
- `cards` — white band trio (same as default, icon-led) placed right after hero
- `dark` — the blue/black checkerboard tiles with line icons and italic uppercase titles — the reference's signature amenities look

**Usage:** Use light variants to break up black sections; use dark checkerboard exactly once per page as the feature moment.

### `content-block`

Measured prose on black: uppercase heading, 300-weight 17px paragraphs.

**Usage:** About/pillar narrative. Stack multiple blocks for long stories.

### `media-block`

Heading + copy beside an unframed high-contrast photo; blue skew CTA optional.

**Usage:** Community/story sections on home and about.

### `stats-band`

Blue diagonal-clipped band, 60px italic 900 values, uppercase micro-labels.

**Usage:** Credibility between black sections; 3-4 stats.

### `logo-strip`

Muted uppercase label over inverted-grayscale logos on black.

**Usage:** Affiliations on about; 3-6 logos.

## Page archetype recipes

Section order a site build should use when composing each page archetype with this template (`type#variant` marks a variant hint):

- **home**: `hero` → `feature-grid#cards` → `program-cards` → `feature-grid#numbered` → `testimonials` → `feature-grid#dark` → `media-block` → `location-map` → `faq` → `cta-band` — Same narrative arc as the vocabulary intends; alternate black and light/blue sections for rhythm — never two light bands adjacent.
- **about**: `content-block` → `logo-strip` → `media-block` → `contact-form`
- **coaches**: `coach-grid` → `cta-band`
- **programs-index**: `program-cards` → `faq` → `cta-band`
- **program-detail**: `hero` → `content-block` → `feature-grid#default` → `testimonials` → `cta-band`
- **schedule**: `schedule` → `cta-band`
- **pricing**: `pricing` → `stats-band` → `faq` → `cta-band`
- **location-contact**: `location-map` → `contact-form`
- **drop-in**: `hero` → `content-block` → `pricing` → `location-map` → `cta-band`
- **getting-started**: `lead-form` — Single-purpose conversion page.
- **landing-page**: `hero` → `feature-grid#default` → `testimonials` → `lead-form`
- **pillar-page**: `content-block` → `media-block` → `faq` → `cta-band`
- **blog-index**: `content-block` → `cta-band`
- **blog-post**: `content-block` → `cta-band`
- **testimonials**: `testimonials` → `stats-band` → `cta-band`
