# Clone QA Report — Ship/No-Ship Gate + Inspector (v1)

**Date:** 2026-08-02
**Status:** Design — approved in brainstorming, pending written-spec review
**Engine:** `@milo/clone-engine` (`packages/clone-engine`)
**Replaces:** the build-metrics dump in `src/report.ts` (`generateHtmlReport` / `BuildReport`)
**Depends on:** `buildSite()` (`src/orchestrate.ts`), the source captures (`capture.ts` → `capture.json` + `source-desktop.png`), the projected + built Astro `dist/` per page, the live source origin (for the homepage Lighthouse before-run)
**Reuses:** `src/pixel.ts` (pixel diff), `src/edit/snapshot.ts` (`renderSnapshot`, `sectionListOf`), `src/edit/verify.ts` (box-overlap logic), the astro-build plumbing in `orchestrate.ts`
**Doctrine:** `packages/clone-engine/DOCTRINE.md`; eval rule: `feedback_never_regress_html_eval` memory
**Admin contract:** extends `build-report.json` — the admin dashboard data contract (`2026-08-01-milo-admin-design.md`)

## Purpose

Turn the build report from a **build-metrics dump into a ship/no-ship QA gate.** Today `report.ts` shows per-page timing, LLM cost, and cache state — none of which answers the only question that matters after a clone runs: **is this cloned site good enough to hand to the gym, or does it need fixing first?** Nothing in the current pipeline ever *inspects the cloned result*; the report is a receipt for work done, not a verdict on work quality. It is worthless for the decision it should drive.

The redesign gives the report one job: **at a glance, tell the operator whether to ship, list exactly what's broken and where, and prove fidelity visually.** The engine gains a new capability underneath it — **the Inspector** — a post-build step that renders the finished clone and runs a battery of checks that produce that verdict.

## Reader + the decision it drives

**Reader = ops / the operator** deciding, per cloned site: **ship it to the gym now, or fix it first.** Not a developer profiling a build; not a finance owner watching LLM spend. The report must answer *ship vs. fix* in the first screen, then hand the operator a punch-list of concrete fixes, then let them eyeball the fidelity.

Everything that does not serve that decision is demoted or removed. Timing and cost become a footnote.

## The verdict — a pragmatic bar

**A clone is never pixel-identical to the live source, and that is expected, not a defect.** Fonts render differently on a fresh host, and a form loses its backend in a static clone (it renders but submits nowhere). External embeds are a happier story: an `<iframe>` to external content (map, video, booking) **replicates for free** as long as the clone preserves its `src` — the external service serves it at runtime — so the model there is preserve-and-verify, not re-capture. So the bar is **"no blockers," not "pixel-perfect."** The verdict is derived mechanically from the Inspector's issue list:

- **`✅ SHIP`** — zero blocker-severity issues. (Notes may exist; they don't block.)
- **`⚠ NEEDS FIXES (N blockers)`** — one or more blocker issues; `N` = blocker count.

### Blocker vs. Note

| Severity | Meaning | Kinds | Effect on verdict |
|---|---|---|---|
| **blocker** | The clone is materially broken vs. the source — a visitor (or a search crawler) would see something wrong that the source did not. | broken/missing images & logos; empty-or-missing content block (present + non-empty in source, empty/absent in clone); **dropped iframe** (an `<iframe>` in the source that the clone stripped — lost embedded content); dead internal link / broken nav target; layout break (section overlap / broken responsive); **SEO-element regression** (an SEO element the *source* had that the clone *dropped* — see Site Health) | **→ `NEEDS FIXES`** |
| **note** | Expected static-clone divergence — flagged for awareness, never a defect. | fallback font (intended brand font didn't load); a static-only form (submits nowhere without a backend); a **same-domain iframe** (its `src` pointed at the source's own domain — won't resolve on the clone's domain); a **referrer/domain-locked embed** (a preserved external iframe that may refuse to load off the original site) | **flagged, does not block** |

Note the asymmetry that runs through the whole gate: **it blocks on *regressions vs. the source*, not on the source's own shortcomings.** A missing meta description that the source also lacked is the *gym's* SEO problem (informational); a meta description the source had and the clone lost is *our* fidelity bug (blocker). Same for any SEO element.

The split is the whole design: it stops the gate from **crying wolf** on the divergences that are inherent to static cloning, while still hard-failing on the ones a gym owner would rightly reject.

## The Inspector — the new capability

A post-build step: for each page, render the finished clone (the astro `dist`) and run a **battery of independent checks** against the source capture. Each check emits zero or more `Issue`s; the verdict is derived from the union. Each check is a **small, independently testable unit** — its own file, its own fixture-driven test, its own false-positive/false-negative controls.

```
Issue = { severity: "blocker" | "note", page, location, kind, detail }
```

`location` pins the issue inside the page ("hero", "nav", "footer", or a section `data-component` name); `kind` is the machine-readable check id; `detail` is the human-readable one-line explanation ("logo image 404", "'Classes' nav link → no built page").

### The checks

Each check below lists **what it detects**, **how**, **severity**, and **which existing machinery it reuses.** The Inspector renders each page once (a shared `renderSnapshot` of the clone `dist`) and passes that render + the page's `capture.json` + `source-desktop.png` to every check, so the expensive render happens once per page.

| Check | Detects | How | Severity | Reuses |
|---|---|---|---|---|
| **broken-assets** | `<img>` / CSS-background that 404s or renders at 0×0 in the built clone | In the clone render, query every `<img>` for `naturalWidth===0 \|\| naturalHeight===0` (broken/failed decode) and every element whose resolved `background-image` URL fails to load; **cross-reference** the astro build's asset-resolution warnings (assets that "didn't resolve at build time") captured from build stderr. Union of render-time 0×0 and build-time unresolved. | **blocker** | the per-page clone `renderSnapshot`; astro-build stderr already shelled from `orchestrate.ts` |
| **content-blocks** | Whether the page's HTML **content blocks** survived the clone present + intact — the merged "is the content there" check (subsumes the old empty/missing-sections). NOT a widget/JS-include hunt | For each content-bearing block/section in the source (`capture.json` tree / `sectionListOf` mapping, keyed by `data-component`) with a non-empty content signal (text length or child-element count above a floor), verify a counterpart exists in the clone render, present with equivalent structure + non-empty content — flag if **absent**, or present but rendering with ~0 content / no visible children. Deliberately about **content presence + integrity**, not visual layout. `<form>` blocks are checked for presence; a form that survived but has no backend is a **note** (`static-form`), not a blocker. **Explicitly out of v1: named chat/booking/video *widget* recognition** (brittle allow-list, low value) — see possible-future. | **blocker** if a source content block is dropped/emptied; **note** for static-only form | `sectionListOf`; source `capture.json` tree; the clone `renderSnapshot` section map (keyed by `data-component`) |
| **dead-internal-links** | An internal `href` or nav target that doesn't resolve to a built page | Collect every internal link + nav target from the clone render (skip `mailto:`/`tel:`/external hosts/in-page `#anchor`s). Resolve each against the set of built routes (`buildSite`'s `links-site.json` / the assembled `full-site/` route set). Any internal target with no matching built page is dead. | **blocker** | `buildSite`'s route map (`links-site.json` / `full-site/` assembly); the clone render's DOM |
| **layout-breaks** | Section bounding-box overlaps / broken responsive | **Reuse the exact overlap logic in `edit/verify.ts`** (`overlaps()` + `OVERLAP_TOLERANCE_PX`): any two section boxes overlapping beyond tolerance = layout break. Run at each capture width (1440 / 768 / 390 — the `WIDTHS` the engine already captures) to catch responsive breakage, not just desktop. | **blocker** | `edit/verify.ts` `overlaps()` + tolerance; `renderSnapshot` section boxes; `WIDTHS` |
| **iframes** | An `<iframe>` in the source **preserved (with `src` intact)** in the clone — external embeds replicate for free at runtime | Model = **preserve-and-verify**, not re-capture: an external iframe (map, YouTube, booking embed) works on the clone as long as the clone kept the `<iframe src>` — the external service serves it. Check each source iframe (`capture.ts` marks `iframe`/`embed`/`object` `NO_REHOST`, so they're knowable) has a surviving clone iframe with the same `src`. **Dropped/stripped iframe = blocker** (lost content). Flag two caveats as **notes**: a **same-domain iframe** (src on the source's own domain → won't resolve on the clone's domain) and a **referrer/domain-locked embed** (external but may refuse off-origin). | **blocker** for a dropped iframe; **note** for same-domain / domain-locked | source `capture.json` (`NO_REHOST` set, tree, `src`s); clone render DOM |
| **font-fallback** | An intended brand font that didn't load (computed family fell back) | For elements the brand doc / labels mark as using a brand font, read `getComputedStyle(...).fontFamily` in the clone render and detect that the resolved face is a generic/system fallback rather than the intended family (font not loaded → browser dropped to the next in the stack). | **note** | the clone `renderSnapshot` page; `brand.json` font slots |
| **fidelity** | Per-page visual similarity source → clone | Diff `source-desktop.png` (already captured) against a fresh full-page screenshot of the clone render, via `pixel.ts` `pixelDiff`. Report a **match %** (`100 − pct`) per page. **NOT a blocker** — benign diffs (fallback fonts, a static form shell, an off-origin embed) are expected; this is the confidence signal + the before/after proof. | **fidelity signal** (never a blocker) | `pixel.ts` `pixelDiff`; the `source-desktop.png` capture; the clone render |
| **seo** | Per-factor **source (before) vs. clone (after)** + why-it-matters + improvement opportunity; **regressions** vs. source | Pure HTML parse of **both** the source (`capture.json` head/tree) and the **built** clone page, for every factor: `<title>`, meta description, single `<h1>` + heading hierarchy, image `alt` coverage, `<link rel="canonical">`, JSON-LD / structured data, Open Graph + Twitter Card, `<html lang>`, robots meta + `sitemap.xml`/`robots.txt`. For each: emit **before value, after value, good/bad + a short why-it-matters reason, and the improvement opportunity.** A factor **dropped** (in source, gone in clone) = **regression (blocker)**; a factor the **source never had** = **improvement opportunity** (informational, actionable — not a blocker). | **blocker** for a source→clone regression; otherwise **informational / opportunity** | source `capture.json` (`head`, `tree`); the built `dist/` HTML |
| **pagespeed** (lightweight, ALL pages, v1) | Page weight + request/asset load | Report built **page weight (KB)** and **asset/request count** per page, plus the largest assets. Uses data already collected during build (`pageWeightKb`, `assetCount`). Pure, no extra tooling. | **informational** (never a blocker) | existing `pageWeightKb` / `assetCount` in the build report; `capture.json` assets |
| **pagespeed** (Lighthouse, **homepage-only, both source + clone, v1**) | Real Core-Web-Vitals + Lighthouse Performance/SEO/Accessibility/Best-Practices scores, **before (live source) vs. after (clone)** | On **every build**, run Lighthouse headless twice — once against the **live source homepage** and once against the **clone homepage** (served `dist/`) — and show the before/after scorecard for the site's most important page. Bounded to ~2 runs (~20–60s/build). Clones are static Astro → the after-scores should **beat** the source (a headline selling point). A blocked/unreachable **source** run degrades gracefully: show the clone score + note source unavailable. | **informational** (never a blocker) | `lighthouse` npm (or PageSpeed Insights API); a headless serve of the clone `dist/` homepage; the live source origin |

### The fidelity signal

Fidelity is deliberately **not** a pass/fail gate. Because fallback fonts, static form shells, and off-origin embeds legitimately change pixels, a low match % is often *expected*, not *wrong* — a form that renders as a static shell will diff, and that's a note, not a blocker. So fidelity is reported as:

- **Overall fidelity %** — an aggregate (e.g. mean per-page match %) in the verdict bar, as a *confidence* number, not a threshold.
- **Per-page match %** with a **source-vs-clone before/after slider**, sorted **worst pages first** — the operator's eyes are the final judge; the report just points them at the pages most worth looking at.

The slider is the existing before/after component already in `report.ts` (inline CSS+JS, no deps), repointed at `source-desktop.png` (before) vs. the clone screenshot (after).

### Site health — SEO + PageSpeed

A section reporting the cloned site's **SEO and performance health**, distinct from visual fidelity. The framing is dual: **the clone is faithful to the source AND an opportunity to improve the gym's SEO** — the report surfaces exactly where.

**SEO — before/after per factor, with reasons (cheap, deterministic, high-value).** For **each** factor (title, meta description, H1 + heading hierarchy, image `alt` coverage, canonical, JSON-LD / structured data, OG/Twitter, `<html lang>`, robots/sitemap), the report shows four things:

1. **Source value (before)** — parsed from the source `capture.json` head/tree.
2. **Clone value (after)** — parsed from the built clone HTML.
3. **Good or bad, and WHY** — a short, educational, per-factor reason the operator (and the gym) can learn from (e.g. "meta description drives the search-result snippet; a missing one lets Google pick arbitrary page text").
4. **Improvement opportunity** — the concrete next step if the factor is weak.

The **rules that map onto the QA verdict** are load-bearing and asymmetric:

- **Dropped** (source had it, clone lost it during capture/projection) → **fidelity regression → BLOCKER.** *Ours* to fix; the `seo` check emits it and the verdict counts it.
- **Source gap** (source never had it) → **improvement opportunity — informational, actionable, never a ship-blocker.** The *gym's* pre-existing SEO gap, surfaced as a place the clone can do better than the original.

Both the **source-SEO and the clone-SEO** are stored in `build-report.json` (per factor, per page) so the admin can render the same before/after table.

**PageSpeed — two tiers, both shipping in v1, both informational (never block the verdict):**

- **(a) Lightweight — ALL pages.** Page weight (KB), request/asset count, largest assets. Already captured (`assetCount` / `pageWeightKb`) at build — free.
- **(b) Lighthouse — HOMEPAGE ONLY, source + clone, every build.** On every build, run Lighthouse twice: once against the **live source homepage** and once against the **clone homepage** (served `dist/`). The report shows a **before/after scorecard** — Performance, SEO, Accessibility, Best-Practices + Core Web Vitals (LCP / CLS / TBT-style) — for the site's most important page. Because clones are static Astro (inherently fast), the after-scores should **beat** the source — a headline selling point ("homepage: 54 → 96"). Cost is bounded to ~2 runs (~20–60s/build), which is acceptable. A blocked/unreachable **source** run degrades gracefully: show the clone score and note the source is unavailable (never fail the build on it).

Only an SEO **regression vs. source** blocks; everything else in Site Health is informational.

## Report structure (top to bottom)

The HTML is restructured around the **decision**, not the build. Order is fixed:

1. **Verdict** — `✅ SHIP` or `⚠ NEEDS FIXES (N blockers)`, plus overall fidelity % and page count. The one-glance answer, above the fold.
2. **Blockers punch-list** — each blocker as one row pinned to **page + location**, e.g.:
   - `/pricing — logo image 404`
   - `/ — hero — section empty`
   - `/ — nav — "Classes" link dead`
   - `/about — footer — overlaps content`
3. **Noted (won't block)** — font fallbacks, static-only forms, same-domain / domain-locked iframes, etc., same page+location framing, visually de-emphasized so they never read as failures.
4. **Fidelity proof** — per-page **source-vs-clone** with match % and the before/after slider, **worst pages first.**
5. **Site health — SEO + PageSpeed** —
   - **SEO before/after table** per factor (source value | clone value | good/bad + why-it-matters | improvement opportunity). Dropped-vs-source elements also surface as blockers up in the punch-list, not only here; source gaps read as improvement opportunities.
   - **Homepage Lighthouse scorecard** — before (live source) vs. after (clone): Performance, SEO, Accessibility, Best-Practices + Core Web Vitals, framed as the headline win ("54 → 96"); source-unavailable handled gracefully.
   - **Lightweight PageSpeed table** — weight / asset count / largest assets, all pages.
6. **Cost & Speed** — a real section (not a footnote): per-page **and** aggregate build cost + speed. **Reuse the honest cold-vs-warm accounting already in `report.ts`** (per-page capture fresh/cached-est + project + build ms; per-page LLM label cost; aggregate cold-build total vs. this-run wall; total LLM $, $/page, and $/site projection). It ranks below the verdict, blockers, fidelity, and site health — but it is kept in full, because the operator genuinely wants build cost + speed visibility.

The report **leads with the QA decision** (verdict → blockers → notes → fidelity → site health); **Cost & Speed** lives at the bottom as its own full section, not a throwaway line.

## Persistence / schema

`build-report.json` is the admin-dashboard data contract; the redesign **extends** it (does not replace the file). The new inspection payload rides alongside the existing per-page data so the admin can render the same verdict/punch-list the HTML shows.

```ts
type Severity = "blocker" | "note";
type IssueKind =
  | "broken-asset" | "content-block-dropped" | "dead-link" | "layout-break"  // blockers
  | "iframe-dropped"                                                         // blocker (lost embed)
  | "seo-regression"                                                         // blocker (dropped-vs-source)
  | "font-fallback" | "static-form" | "iframe-same-domain" | "iframe-domain-locked"; // notes

interface Issue {
  severity: Severity;
  page: string;        // route, e.g. "/pricing"
  location: string;    // "hero" | "nav" | "footer" | data-component name | "page"
  kind: IssueKind;
  detail: string;      // one-line human explanation
}

interface PageFidelity {
  page: string;
  matchPct: number;    // 100 - pixelDiff.pct
  sourceThumb: string; // rel path — source-desktop.png (before)
  cloneThumb: string;  // rel path — clone screenshot (after)
}

// Per SEO factor: BEFORE (source) vs AFTER (clone), a good/bad judgement with an
// educational reason, and the improvement opportunity. `dropped` (source had it,
// clone lost it) drives the seo-regression blocker; `sourceGap` (source never had
// it) is an informational improvement opportunity — never a blocker.
interface SeoFactor {
  sourceValue: string | null;  // BEFORE — parsed from source capture (null = absent in source)
  cloneValue: string | null;   // AFTER  — parsed from built clone HTML (null = absent in clone)
  status: "good" | "weak" | "missing";
  why: string;                 // short educational reason this factor matters for SEO
  opportunity: string | null;  // concrete improvement step, or null when already good
  dropped: boolean;            // source had it, clone lost it → seo-regression BLOCKER
  sourceGap: boolean;          // source never had it → improvement opportunity (informational)
}
interface PageSeo {
  page: string;
  title: SeoFactor;
  metaDescription: SeoFactor;
  headings: SeoFactor;         // single H1 + heading hierarchy
  imageAlt: SeoFactor;         // coverage % in values
  canonical: SeoFactor;
  jsonLd: SeoFactor;           // structured data
  openGraph: SeoFactor;
  twitter: SeoFactor;
  lang: SeoFactor;
  robots: SeoFactor;           // robots meta + sitemap.xml / robots.txt presence
}

// Lighthouse scores for one target (source or clone). Absent if that run failed/was unreachable.
interface LighthouseScores {
  performance: number; seo: number; accessibility: number; bestPractices: number; // 0-100
  lcpMs?: number; cls?: number; tbtMs?: number;   // core-web-vitals-ish
}

interface PageSpeed {
  page: string;
  // Lightweight tier (v1, ALL pages) — from data already collected during build.
  pageWeightKb: number;
  assetCount: number;
  largestAssets: Array<{ url: string; kb: number }>;
  // Lighthouse tier (v1, HOMEPAGE ONLY) — before (live source) vs after (clone),
  // present only on the homepage PageSpeed entry. `source` absent → source unreachable.
  lighthouse?: {
    source?: LighthouseScores;  // BEFORE — live source homepage (graceful-absent)
    clone: LighthouseScores;    // AFTER  — clone homepage (served dist/)
  };
}

interface PageInspection {
  page: string;
  issues: Issue[];         // this page's blockers + notes (incl. seo-regression, iframe-dropped)
  fidelity: PageFidelity;
  seo: PageSeo;
  pagespeed: PageSpeed;
}

interface InspectionReport {
  verdict: "ship" | "needs-fixes";
  blockerCount: number;
  blockers: Issue[];       // flattened, all pages
  notes: Issue[];          // flattened, all pages
  overallFidelityPct: number;
  pages: PageInspection[]; // fidelity sorted worst-first for the proof section
}

// build-report.json gains `inspection`; the existing per-page timing/cost stays in
// pages[] and now backs the dedicated Cost & Speed section (not a footnote).
interface BuildReport {
  /* ...existing fields (site, origin, generatedAt, totalWallMs, pages[] with
     per-page captureMs/projectMs/buildMs/freshCaptureMs + LLM label cost)... */
  inspection: InspectionReport;   // NEW — the QA + site-health payload
}
```

This is an **additive** change to the contract: the existing per-page timing/cost data in `pages[]` is untouched (it now backs the Cost & Speed section); the admin team reads the new `inspection` field (with its `seo` + `pagespeed` per page) but is not forced to migrate anything existing.

## Architecture / module split

A new **`src/qa/`** module. One orchestrator + one file per check + a types file — mirroring the `src/edit/` layout so each check is independently testable.

```
packages/clone-engine/src/qa/
  types.ts               # Issue, IssueKind, Severity, PageInspection, InspectionReport, PageFidelity, PageSeo, SeoFactor, PageSpeed, LighthouseScores
  inspect.ts             # orchestrator: for each page → render clone once → run all checks → derive verdict
  checks/
    broken-assets.ts     # blocker — 0×0 imgs / failed bg-images + build-warning cross-ref
    content-blocks.ts    # blocker — source HTML content block dropped/emptied in clone; note — static-only form (NOT a widget hunt)
    iframes.ts           # blocker — source iframe dropped (lost embed); note — same-domain / domain-locked embed. preserve-and-verify
    dead-links.ts        # blocker — internal href/nav → no built route
    layout-breaks.ts     # blocker — box overlaps (reuses edit/verify overlap) across WIDTHS
    font-fallback.ts     # note    — computed font-family fell back
    fidelity.ts          # signal  — pixelDiff source-desktop vs clone screenshot → match %
    seo.ts               # blocker-on-regression + informational — BEFORE(source) vs AFTER(clone) per factor, with why + opportunity
    pagespeed.ts         # informational — lightweight all-pages (pure) + homepage Lighthouse before/after (v1)
  verdict.ts             # pure: Issue[] → { verdict, blockerCount, blockers[], notes[] }
  index.ts               # inspect(site) → InspectionReport
```

- **`content-blocks.ts` checks HTML content-block presence + integrity, not widgets.** For each content-bearing block in the source it verifies a surviving, non-empty counterpart in the clone — a dropped/emptied block is a **blocker**. Forms are checked for presence; a surviving-but-backend-less form is a **note** (`static-form`). It deliberately does **NOT** carry a chat/booking/video widget allow-list (brittle, low value) — that removes the earlier false-negative worry and is only a possible-future item.
- **`iframes.ts` is preserve-and-verify.** External iframes replicate for free when the clone keeps `<iframe src>`; the check confirms each source iframe survived with `src` intact. A **dropped** iframe = **blocker** (lost embedded content). Two caveats are **notes**: a **same-domain** iframe (won't resolve on the clone's domain) and a **referrer/domain-locked** external embed (may refuse off-origin). It reuses the source `capture.json` `NO_REHOST` set, which already marks `iframe`/`embed`/`object`.
- **`seo.ts` is a pure HTML parser over BOTH sides** — the source `capture.json` head/tree (before) and the built `dist/` HTML (after) — emitting a `SeoFactor` per factor with before value, after value, a good/bad + educational reason, and an improvement opportunity. It emits an `seo-regression` **blocker** only for a **dropped** factor (in source, gone in clone); a **source gap** (never in source) is an informational improvement opportunity. No browser, no network — cheap and deterministic.
- **`pagespeed.ts` has two paths, both v1.** The lightweight path is pure (weight/asset data already gathered at build) and runs for **all pages**. The Lighthouse path runs **only on the homepage**, twice per build — **live source** (before) and **clone** (after) — for the headline before/after scorecard. It adds the `lighthouse` dependency and needs a served clone `dist/` homepage + reachability to the live source; a blocked/unreachable **source** run degrades gracefully (clone score shown, source noted unavailable). Bounded to ~2 runs/build. It never blocks the verdict.

- **`inspect(assembledSite) → InspectionReport`** is the one public entrypoint. It renders each built page once (shared `renderSnapshot` on the clone `dist`), fans the render + source capture + route map out to each check, unions the issues, and calls the pure `verdict()`.
- **Reuse, don't reinvent:** the checks call into `pixel.ts` (fidelity), `edit/snapshot.ts` (`renderSnapshot`, `sectionListOf`), and `edit/verify.ts`'s overlap primitive. If the overlap primitive isn't already exported, promote it to a shared helper both `verify.ts` and `layout-breaks.ts` import — one implementation, two callers (leverage: the never-regress overlap logic and the QA overlap check can never drift).
- **`report.ts` — RESTRUCTURE, not rewrite the shell.** Keep the self-contained inline-CSS/JS HTML approach, the existing before/after slider, **and the existing honest cold-vs-warm cost accounting** (per-page capture fresh/cached-est + project + build ms, LLM label cost, cold-build-total-vs-this-run-wall, $/page, $/site — all already in `report.ts`, reused verbatim). Change the *content order* to verdict → blockers → notes → fidelity → site health → Cost & Speed. `generateHtmlReport` takes the extended `BuildReport` (now carrying `inspection`) and renders the new structure; the cost math is repositioned, not deleted.
- **Wire into `buildSite`:** after `full-site/` is assembled (`orchestrate.ts`), call `inspect(fullSite, { origin })` → attach `inspection` to the `BuildReport` → `generateHtmlReport`. The Inspector runs on the **assembled, built** output (real `dist/`), because that's what actually ships — inspecting anything earlier would miss build-stage breakage. `inspect` receives the live source `origin` so `pagespeed.ts` can Lighthouse the source homepage; it serves the clone `dist/` homepage locally for the clone run.

## The ONE thing to prove

**On a real cloned site, the report produces a correct, trustworthy verdict and an actionable punch-list** — it catches a real broken asset (blocker), flags a static form (note, not a blocker), and shows per-page fidelity with the worst page surfaced first. Concretely, the acceptance bar:

- A blocker the operator would agree is a blocker (e.g. a genuinely 404'd logo) appears in the punch-list, pinned to the right page + location, and flips the verdict to `NEEDS FIXES`.
- An expected static-clone divergence (a static-only form, a fallback font) appears **only in Notes** and does **not** flip the verdict.
- A **dropped content block** or a **stripped source iframe** flips the verdict to `NEEDS FIXES`; an external iframe that **survived with `src` intact** does **not** (it replicates for free), and a same-domain / domain-locked iframe appears **only in Notes**.
- An SEO factor the **source had and the clone dropped** (e.g. a lost meta description or JSON-LD) appears as a **blocker** and flips the verdict; a factor the source **also lacked** appears as an **improvement opportunity (informational only)** and does **not** flip it — and the SEO section shows **before/after per factor with a why + an opportunity**.
- Fidelity renders the source-vs-clone slider, worst page first, with a believable match %.
- Site Health shows the **homepage Lighthouse before/after scorecard** (source vs clone; clone expected to win) and the all-pages lightweight PageSpeed table; Cost & Speed renders below with real per-page + aggregate numbers.

If the verdict and punch-list are correct and actionable on a real clone, the report has done its job. This is the never-regress rule (`DOCTRINE.md`, `feedback_never_regress_html_eval`) applied to the *report itself*: it must make the ship/no-ship call as well as a careful human eyeballing the clone would.

## Risks

The dominant risk is the classic QA-gate failure mode: **a gate that cries wolf or misses real breaks is worse than no gate at all.** Each check is a small unit precisely so its false-positive/false-negative behavior can be pinned individually.

- **False positives (crying wolf) → operators stop trusting the verdict.**
  - *broken-assets:* lazy-loaded / below-the-fold images may report 0×0 before they load. Mitigation: use `renderSnapshot`'s existing settle/wait behavior; only flag after the page has settled; treat truly-never-loaded as the blocker.
  - *content-blocks:* a block legitimately shorter in the clone (a collapsed dynamic list) can look "empty." Mitigation: require a non-empty **source** signal AND a near-zero **clone** signal, with a content floor, not strict equality.
  - *layout-breaks:* the 1–2px seam tolerance already tuned in `verify.ts` must be reused verbatim; sticky/fixed/absolutely-positioned overlays legitimately overlap and must be excluded from the overlap set.
  - *dead-links:* trailing-slash / index-route normalization must match `buildSite`'s own link map exactly, or every link false-fails. Reuse `links-site.json`, don't re-derive routes.
  - *iframes:* a same-domain or domain-locked embed that legitimately won't load on the clone must land as a **note**, not a blocker — the blocker is only a *dropped* iframe, not one that survived but may not render off-origin.
- **False negatives (missing real breaks) → the gate ships a broken site.**
  - *broken-assets:* a CSS `background-image` 404 renders as blank, not 0×0 — the render-only check can miss it; this is why the check **cross-references build-time asset-resolution warnings**, catching what the render alone can't.
  - *content-blocks vs. static-form boundary:* a block that fails to render at all (dropped → blocker) vs. a form that renders but has no backend (static → note) must be disambiguated correctly, or a real break gets mislabeled a benign note.
- **Fidelity misread as a gate.** Someone could wire the fidelity % into the verdict; that would immediately cry wolf on every clone with a fallback font. It is, by design, a signal only — this must stay true.
- **SEO check over-blocking.** The blocker is *specifically* a source→clone regression, not weak SEO. If `seo.ts` ever blocks on a merely-missing factor the source also lacked, the gate cries wolf on the gym's own SEO gaps. The `dropped` vs. `sourceGap` split is the guard; the source-side parse must be robust (e.g. a source meta description present-but-empty vs. genuinely absent). PageSpeed (both tiers) must **never** contribute a blocker — it is informational by construction.
- **Homepage Lighthouse (now bounded, low risk).** Bounding Lighthouse to the **homepage only** (source + clone, ~2 runs, ~20–60s/build) resolves the earlier feasibility concern — it is no longer per-page, so it does not scale build time with page count. Residual risks, all handled: the run adds the `lighthouse` dependency and needs a **served** clone `dist/` homepage (a short-lived local static server) plus network reachability to the **live source**; a blocked/slow/unreachable source run must **degrade gracefully** (emit the clone score, mark source unavailable — never fail the build). Score variance between runs is expected; the before/after headline should be read as a range, not a guarantee. It never blocks the verdict.
- **Content-block scope discipline (leverage of downscoping #1).** By checking **content-block presence + integrity** instead of chasing named chat/booking/video widgets, we removed a brittle maintained allow-list AND its false-negative surface. The residual risk is the opposite — a genuinely dynamic block that the source rendered server-side but the clone can't reproduce could read as "present but thin"; the content floor (shared with `content-blocks`) is the tuning knob, and test fixtures must cover both sides of it. Named-widget recognition is explicitly **possible-future**, not v1.
- **Detectors of genuinely uncertain reliability (flagged honestly, not hand-waved):**
  - **`font-fallback`** depends on detecting that a computed family resolved to a fallback rather than the intended face. Distinguishing "loaded the brand font" from "fell back to a same-named system font" is not always crisp across platforms; this is why it's a **note**, not a blocker — a wrong call here is low-cost.
  - **`content-blocks` content floor** is a tuned threshold; it will need calibration on real clones to sit between "collapsed-but-fine" and "genuinely dropped." The unit test fixtures must include both sides of that line.
  - **`seo.ts` source-side comparison** — present-but-empty vs. genuinely-absent in the *source* is the crux of the dropped/regression call; a wrong read here either over-blocks (cries wolf) or misses a real drop. It is guarded by making the *regression* (not the shortcoming) the only blocker trigger, so a wrong call fails toward informational rather than toward a false ship-block.

## Out of scope (explicit YAGNI)

- **Auto-fixing** any blocker. The Inspector reports; fixing is a separate edit-op flow (subsystem C). The report is a gate, not a remediator.
- **Per-page Lighthouse.** Lighthouse runs on the **homepage only** (source + clone) in v1 — the most important page, bounded to ~2 runs/build. Running it on every page is out of scope (it would scale build time with page count). The lightweight PageSpeed tier (weight/asset count) covers all pages.
- **Named chat/booking/video widget recognition.** Deliberately dropped from v1 (brittle allow-list, low value). `content-blocks` checks HTML content presence + integrity instead; `iframes` handles external embeds via preserve-and-verify. A maintained widget-signature layer is only a **possible-future** item.
- **General site-quality opinions beyond source fidelity + SEO fundamentals.** The QA report is not a marketing/CRO audit; SEO here is before/after fundamentals + regression-vs-source + improvement opportunities, not a growth recommendation engine (that's the keyword-brain's job).
- **Cross-page / whole-site semantic checks** beyond internal-link resolution (e.g. "is the messaging consistent"). Per-page structural + visual + SEO fidelity only in v1.
- **Content-correctness judgment** ("is this the right copy"). The Inspector checks that what the source had, the clone has — not whether the source was any good.
- **Blocking the build.** `buildSite` still produces `full-site/`; the Inspector annotates it with a verdict. The *operator* decides not to ship; the engine doesn't refuse to assemble. (A future admin gate could refuse deploy on `needs-fixes`, but that's the admin's policy, not the engine's.)
- **Replacing the pixel oracle** (`project.ts` 0-px baseline). That proves the *projection* is lossless; the Inspector's fidelity proves the *built clone resembles the live source*. Different jobs; both stay.

## Self-review

- **Placeholders:** none. Every check names concrete existing machinery it reuses (`pixel.ts`, `edit/snapshot.ts`, `edit/verify.ts` overlap, `capture.json` head/tree + `NO_REHOST` set, `links-site.json`, `source-desktop.png`, `WIDTHS`, `pageWeightKb`/`assetCount`, astro-build stderr). The only *new* dependency is Lighthouse, now scoped to the homepage (source + clone) in v1 — a concrete, bounded addition, not a placeholder.
- **Consistency with the codebase:** the module layout mirrors `src/edit/` (orchestrator + per-unit files + `types.ts`); the report stays self-contained inline-HTML per the existing `report.ts` convention; `build-report.json` is *extended* additively (the admin contract note in `report.ts` is honored — shape isn't broken, only widened with `inspection`, `SeoFactor` before/after, and homepage Lighthouse source+clone).
- **Consistency with approved decisions (incl. the four refinements):** (1) `dynamic-features` downscoped to **content-block presence + integrity** (`content-blocks.ts`) — no widget allow-list in v1; (2) **iframes preserve-and-verify** (`iframes.ts`) — dropped iframe = blocker, same-domain / domain-locked = notes; (3) **SEO before/after per factor** with why + opportunity, source-SEO AND clone-SEO both persisted, dropped = blocker vs. source-gap = opportunity; (4) **homepage-only Lighthouse, source + clone, every build** in v1, graceful on source-unreachable. Verdict = pragmatic ship/no-ship; report leads with the QA decision (verdict → blockers → notes → fidelity → **site health** → **Cost & Speed**); fidelity is a signal, never a gate; PageSpeed never blocks. Nothing previously decided was re-opened.
- **Scope:** additive to `buildSite`; does not touch the projection oracle, the edit subsystem's verifier semantics, or the capture pipeline (only *reads* its outputs, now including the live source origin for the homepage Lighthouse before-run). `report.ts` content is restructured; its HTML-shell + before/after-slider conventions are preserved; Cost & Speed retained in full, ranked below the QA decision. Earlier-draft contradictions resolved: SEO + both PageSpeed tiers are **in** v1; only per-page Lighthouse and named-widget recognition are out.
- **Ambiguity honestly flagged:** the genuinely-uncertain calls now are `font-fallback` cross-platform detection, the `content-blocks` content floor, and the `seo.ts` source-side present-but-empty vs. absent read — all in Risks, all failing toward informational/note rather than a false ship-block. The two false-negative worries the refinements *removed* (named-widget allow-list; heavy per-page Lighthouse) are noted as resolved: widget-chasing is replaced by content-block + iframe checks, and Lighthouse is bounded to one page.
