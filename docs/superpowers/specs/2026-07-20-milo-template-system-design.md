# Milo Template System — design

**Date:** 2026-07-20
**Status:** Approved design (brainstorm), pre-plan
**Supersedes the *goal* of:** `2026-07-20-template-ir-design.md` (URL reproduction — abandoned).
**Anchored by:** memory `project_milo_direction_pivot`.

## What Milo is

Milo builds a small library of **excellent, owned website templates**. Gym clients are **fitted into** our templates — we do **not** reproduce or clone a client's existing site. Each client is represented by a **living set of documents**; a website is one *projection* of those documents through a chosen template. Rebuilding a site (same or different template) is instant, and gets **better over time** as we learn more about the client and store it in their documents.

### Priority order (what makes a template "great")
1. **Performance** — fast, minimal-JS static output
2. **SEO** — semantic markup, metadata, sitemaps, canonicals, structured data
3. **AEO / GEO** — content structured for AI answer & generative engines (FAQ/entity schema, clean Q&A, `llms.txt`)
4. **Google local discovery** — `LocalBusiness`+geo+hours+reviews, location pages, NAP consistency
5. **Content engine** — write blogs, build pillar pages, internal linking
6. **Accurate AI-assistant editability** — edits mutate validated docs, never fragile HTML
7. **Looks amazing** — real, but ranks *below* discovery; and never means "pixel-identical to any source"

Discovery (2–4) is the deepest design driver. It is **built into the components**, not bolted on (see Discovery-native components).

## Core model

```
   Documents (the living knowledge base, template-agnostic)
   ├── content docs  ── identity, brand+tokens, programs, coaches, schedule,
   │                     pricing, testimonials, faq, locations, media, hierarchy,
   │                     blog/pillar content, seo-profile        ── WHAT renders
   └── knowledge docs ── members, leads, who-buys, demographics,   ── INFORMS the
                          what-converts (fed by PushPress data)       render (later)
        │
        ▼  render (instant, static)
   Template (theme) = component library + design language
        +  Brand tokens (colors, fonts, spacing, radius, borders, style)  ← per-client skin
        =  a live static site, measured by objective discovery/perf gates
```

- **Portability is a hard requirement.** A client's site can move to any template with zero content rework, because documents are template-agnostic and every theme implements the same **shared section contract**.
- **Rebuild > initial build.** Documents are a durable knowledge base kept cleanly separate from rendered output, so re-rendering with *more* knowledge (their real buyers, converting leads, local terms) produces a better site each time. The knowledge comes from **PushPress platform data** (members, leads, enrollments, check-ins, attributions) — the moat a standalone builder can't replicate.

## North Star & invariants

The endgame is a system where a gym's **living documents** compound over time — seeded at onboarding, enriched continuously by PushPress data (members, leads, who-buys) and discovery signals (GSC, analytics, conversion) — and any template is a fast, discovery-native projection of them that an AI can safely edit and regenerate, each rebuild better than the last. Milo isn't a site builder; it's a knowledge base with websites as one output.

Endgame capabilities (context — **out of Phase 1 build scope**): AI-edit assistant (P2) → content engine, blog/pillar/keyword→content (P3) → knowledge loop from PushPress data (P4) → feedback signals closing the loop (GSC/analytics/conversion → proactive rebuilds) → onboarding brand importer.

**The larger endgame — a gym growth platform.** The website is the first surface of a full **lead generation & management** system that manages a gym's growth over time: paid ads + social + marketing campaigns, AI-assisted content creation, ad tracking / performance / attribution, reporting dashboards, an AI marketing assistant, lead intake + forms, lead management/CRM, and automated SMS/email nurture. The document/knowledge base is the shared spine for all of it (the site's leads and conversion data feed the same knowledge that improves rebuilds). All of this is **future** — named here so the document model and lead/forms primitives in Phase 1 don't preclude it.

**Invariants Phase 1 MUST honor** (each is a corner a later phase can't un-paint):
1. Documents are the **sole source of truth**; the site is a **pure, deterministic projection** — nothing lives only in rendered HTML.
2. **Content docs** (what renders) are separate from **knowledge docs** (what informs); render depends only on content docs.
3. The contract is **template-agnostic** — no theme-specific data in documents (100% portability across themes).
4. All state changes go through **schema-validated document mutations**, never direct HTML edits (safe AI editing later).
5. Pages are **composed from token-driven, self-contained components** that emit their own schema (per-page layouts, reskin, compounding discovery).
6. Rendering is **idempotent** from `(documents + theme + tokens)` — same inputs, same site.
7. Facts carry **provenance** where it matters (esp. knowledge docs) — the anti-fudge principle, so AI decisions are traceable, not invented.

These shape *how* Phase 1 is built; they do not add to *what* Phase 1 ships.

## Architecture

### 1. The portable content contract (`packages/schema`)
Typed (Zod), template-agnostic, closed shared vocabulary. Starts from the kept `GymSiteContent` and is refined to a **composition model**:

- **Documents** — one typed schema per content doc (identity, brand, programs, coaches, schedule, memberships, testimonials, faq, locations, media-library, seo-profile, site-hierarchy). Knowledge-doc schemas are stubbed as an extension point but not populated in Phase 1.
- **Composition, not fixed archetypes.** `site-hierarchy` defines pages; each **page = an ordered list of section instances**; each instance = `{ section: <shared section type>, content: <ref or inline>, overrides?: {...} }`. Archetypes become *optional starting compositions*, not rigid page types — any page can mix/reorder sections for a unique layout.
- **Shared section vocabulary** (every theme MUST implement all): `hero, program-cards, coach-grid, schedule, testimonials, faq, cta, lead-form, location, pricing, feature-grid, content-block, media-block, stats-band, logo-strip, blog-list, pillar-body`. Unknown section type fails validation. (`lead-form` renders a conversion form posting to a configurable endpoint; actual lead handling is deferred to the growth platform, but the section + endpoint contract exist now so it isn't precluded.)
- **Portability lint:** documents may reference only shared section types (+ a theme's declared theme-unique component ids while that theme is selected). Content docs carry **no** theme-specific styling — that lives in tokens + theme.

### 2. Brand tokens (the skin)
A per-client `brand` document holds tokens: color roles (primary, accent, surface, text, muted…), fonts (display, body, accent), spacing scale, radius, border, shadow, and a few style flags. Tokens render to **CSS custom properties** at the site root. **Theme components consume tokens; they never hardcode values** (this is the explicit fix for the deleted hand-authored templates). Tokens must satisfy contrast (WCAG AA) — validated.

### 3. Themes (component libraries)
A theme = `{ manifest, components/, layouts/, base styles }`:
- **manifest** — id, name, design language, the shared sections it implements, and any **theme-unique components** (which must build on / degrade to shared sections so portability holds).
- **components** — Astro components, token-driven, **discovery-native** (below).
- **Template #1 direction:** the `pushpress-site-modern` aesthetic (clean, bold, broadly flattering). Built as our own implementation; the captured `styles.json`/screenshots are *reference material only*, never copied.
- Many themes later; the contract guarantees any client renders on any theme.

### 4. Discovery-native components
Discovery optimization is a **property of each component**, emitted by construction:
- **Perf:** static Astro, zero/minimal client JS, `astro:assets` image optimization, self-hosted subsetted fonts, no layout shift.
- **SEO:** semantic HTML5 landmarks, per-page `<title>`/description/canonical, `sitemap.xml`, `robots.txt`, OpenGraph/Twitter tags.
- **Local:** `LocalBusiness` (gym subtype) JSON-LD with NAP, geo, `openingHours`, `sameAs`, `aggregateRating`; dedicated location pages.
- **AEO/GEO:** `FAQPage` (faq), `Person` (coaches), `Service`/`Offer` (programs/pricing), `Organization`, `Review`; clean heading hierarchy; concise answerable blocks; `llms.txt`.
- **a11y:** WCAG AA contrast, alt text, keyboard/focus, landmarks.

### 5. Rendering (`apps/renderer`, rebuilt)
`documents + theme + tokens → static site`. Astro build; tokens injected as CSS custom properties; blog/pillar via Astro content collections. Replaces the deleted template-registry renderer. Fast enough that "instant rebuild" and "switch template" are cheap re-renders.

### 6. Interactivity, animation, Lottie (first-class, within the perf budget)
Templates support real interactivity and motion **now**, not deferred: scroll/entrance animations, hover/interactive components, and **Lottie** animations. The constraint is that priority #1 (performance) still wins — so:
- Prefer CSS/`@keyframes` and the Web Animations API; use JS only where needed, via **Astro islands** (component-scoped hydration), never a whole-page framework.
- **Lottie loads lazily** (on view / after idle), players are dynamically imported, and animations are gated on `prefers-reduced-motion`.
- Interactivity/animation is a **token-driven component property** like everything else — it degrades gracefully and never blocks the performance gate. If motion can't stay within the perf budget, the perf gate wins.

### 7. Publish (`apps/publish`, later phase)
Build output (HTML + assets) publishes to **S3**, fronted by a **CDN that dynamically routes and serves** it. Two environments per site: a **staging** (work-in-progress, viewable) version and a **production** version reached only by an **explicit publish** action (never automatic — consistent with prior staging/publish semantics). Prior infra exists (S3 `pushpress-marketing-dev` + a CloudFront viewer-request router on the `unicorn` AWS profile); **open decision:** use that existing CloudFront path or move to Cloudflare (see Open items). Publish is its own phase, after Template #1 renders locally + passes gates.

## Objective "great" bar (acceptance gates)
Un-fudgeable, measured by standard scorers (not opinion):

| Dimension | Gate |
|---|---|
| Performance | Lighthouse mobile ≥ 95; all Core Web Vitals green |
| SEO | Lighthouse SEO 100; valid sitemap/robots/canonical; unique title+meta per page |
| AEO/GEO | Valid `FAQPage`+entity JSON-LD (Rich Results-clean); `llms.txt` present; heading/answer structure |
| Local | Valid `LocalBusiness`+geo+hours+`aggregateRating`; location page per location |
| a11y | axe: 0 serious/critical; WCAG AA contrast (incl. brand tokens) |
| Motion | Animations/Lottie honor `prefers-reduced-motion`; perf gate holds with motion enabled (Lottie lazy, JS islands only) |
| Contract | Sample gym renders through Template #1 with every shared section; blog + pillar render with schema; portability lint passes |

A build is "done" only when all gates pass for the sample gym. Gates are checked-in and run in CI.

## Phasing

- **Phase 1 — contract + Template #1:** the portable content contract + brand-token system + **Template #1** (discovery-native, token-skinned Astro component library implementing all shared sections + blog/pillar layouts, **including interactivity / animation / Lottie within the perf budget**) + a sample-gym fixture, all passing the objective gates. Knowledge-doc schemas stubbed as extension points but not populated. Rebuilt renderer.
- **Phase 1b — portability proof:** **Template #2** in a genuinely different design language (contract-stress quality — all shared sections, real second look, not necessarily full polish), then **render the sample gym through both and port between them**. This is the real proof of the portability invariant, and it replaces the earlier "skeleton theme" idea. (Build-order between 1 and 1b is the open decision below.)
- **Publish:** `apps/publish` — S3 + CDN, **staging** (WIP, viewable) and **production** (explicit publish). Slots in once Template #1 renders + passes gates locally.
- **Phase 2:** AI-assistant editing (safe, validated document mutations).
- **Phase 3:** content engine (blog/pillar generation, internal linking, keyword→content).
- **Phase 4:** knowledge-accumulation loop fed by PushPress data (members/leads/buyers) → smarter rebuilds.
- **Beyond:** the gym growth platform (ads, social, campaigns, ad tracking/attribution, reporting, AI marketing assistant, lead intake/forms/CRM, SMS/email nurture) — all on the same document/knowledge spine.
- **Later / optional:** onboarding brand importer (repositioned Phase 0 capture) to pre-fill content docs.

## Kept / repositioned / superseded
- **Kept & central:** `GymSiteContent` → refined into the portable contract; `packages/llm`.
- **Repositioned:** `apps/studio` capture → future onboarding importer, not a fidelity engine.
- **Superseded:** the URL-reproduction goal + its extract/align/pixel-eval/fix loop (`2026-07-20-template-ir-design.md`).
- **To rebuild:** `apps/renderer` (deleted) → documents+theme+tokens renderer.

## Open items (resolve in planning/implementation)
- Final shared-section list (above is the working set; lock during contract TDD).
- Brand-token schema specifics (which roles/scales) and the contrast-validation rule.
- Sample-gym fixture (reuse/refresh `iron-anchor`).
- Exact Lighthouse/CWV thresholds if different from the standard targets above.
- **Build order — RESOLVED (2026-07-20):** build Template #1 (full) then Template #2 in a different design language (contract-stress quality), and **port the sample gym between them before any dependent phase**. Proves the portability invariant earliest. → Phase 1 = contract + Template #1; Phase 1b = Template #2 + port; both before P2/P3/Publish.
- **CDN for Publish — RESOLVED (2026-07-20):** reuse existing AWS **CloudFront** router (S3 `pushpress-marketing-dev`, viewer-request KVS router, `unicorn` AWS profile). Not Cloudflare.
- **Lead/forms — RESOLVED (2026-07-20):** include a `lead-form` shared section (renders form + posts to a configurable endpoint) in Phase 1; backend lead handling deferred to the growth platform.
