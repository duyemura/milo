# Clone QA Report — Ship/No-Ship Gate + Inspector (v1)

**Date:** 2026-08-02
**Status:** Design — approved in brainstorming, pending written-spec review
**Engine:** `@milo/clone-engine` (`packages/clone-engine`)
**Replaces:** the build-metrics dump in `src/report.ts` (`generateHtmlReport` / `BuildReport`)
**Depends on:** `buildSite()` (`src/orchestrate.ts`), the source captures (`capture.ts` → `capture.json` + `source-desktop.png`), the projected + built Astro `dist/` per page
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

**A clone is never pixel-identical to the live source, and that is expected, not a defect.** Fonts render differently on a fresh host, dynamic features (forms, booking widgets, maps, live chat) can't run in a static clone, and third-party embeds are intentionally not rehosted (`capture.ts` marks `iframe`/`embed`/`object` as `NO_REHOST`). So the bar is **"no blockers," not "pixel-perfect."** The verdict is derived mechanically from the Inspector's issue list:

- **`✅ SHIP`** — zero blocker-severity issues. (Notes may exist; they don't block.)
- **`⚠ NEEDS FIXES (N blockers)`** — one or more blocker issues; `N` = blocker count.

### Blocker vs. Note

| Severity | Meaning | Kinds | Effect on verdict |
|---|---|---|---|
| **blocker** | The clone is materially broken vs. the source — a visitor (or a search crawler) would see something wrong that the source did not. | broken/missing images & logos; empty-or-missing section (present + non-empty in source, empty/absent in clone); dead internal link / broken nav target; layout break (section overlap / broken responsive); **SEO-element regression** (an SEO element the *source* had that the clone *dropped* — see Site Health) | **→ `NEEDS FIXES`** |
| **note** | Expected static-clone divergence — flagged for awareness, never a defect. | fallback font (intended brand font didn't load); dynamic feature that can't run statically (form, booking/scheduling widget, iframe map, live chat, video embed) | **flagged, does not block** |

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
| **empty/missing-sections** | A section present **and non-empty** in the source that is **empty or absent** in the clone | Enumerate source sections from the capture (`sectionListOf` mapping / the labeled `capture.json` tree) with a non-empty content signal (text length or child-element count above a floor). For each, find its counterpart in the clone render by `data-component`; flag if absent, or present but rendering with ~0 content height / no visible children. | **blocker** | `sectionListOf`; the clone `renderSnapshot` section map (keyed by `data-component`) |
| **dead-internal-links** | An internal `href` or nav target that doesn't resolve to a built page | Collect every internal link + nav target from the clone render (skip `mailto:`/`tel:`/external hosts/in-page `#anchor`s). Resolve each against the set of built routes (`buildSite`'s `links-site.json` / the assembled `full-site/` route set). Any internal target with no matching built page is dead. | **blocker** | `buildSite`'s route map (`links-site.json` / `full-site/` assembly); the clone render's DOM |
| **layout-breaks** | Section bounding-box overlaps / broken responsive | **Reuse the exact overlap logic in `edit/verify.ts`** (`overlaps()` + `OVERLAP_TOLERANCE_PX`): any two section boxes overlapping beyond tolerance = layout break. Run at each capture width (1440 / 768 / 390 — the `WIDTHS` the engine already captures) to catch responsive breakage, not just desktop. | **blocker** | `edit/verify.ts` `overlaps()` + tolerance; `renderSnapshot` section boxes; `WIDTHS` |
| **font-fallback** | An intended brand font that didn't load (computed family fell back) | For elements the brand doc / labels mark as using a brand font, read `getComputedStyle(...).fontFamily` in the clone render and detect that the resolved face is a generic/system fallback rather than the intended family (font not loaded → browser dropped to the next in the stack). | **note** | the clone `renderSnapshot` page; `brand.json` font slots |
| **dynamic-features** | Forms, iframe maps, known booking/chat/video widgets present in source that are now static | Detect in the clone render (cross-checked against source `capture.json`): `<form>` elements, `<iframe>`s (maps/video/booking), and known third-party widget signatures (booking/scheduling, live-chat, video embeds). `capture.ts` already flags `iframe`/`embed`/`object` as `NO_REHOST`, so their presence in source is knowable. | **note** | source `capture.json` (`NO_REHOST` set, tree); clone render DOM |
| **fidelity** | Per-page visual similarity source → clone | Diff `source-desktop.png` (already captured) against a fresh full-page screenshot of the clone render, via `pixel.ts` `pixelDiff`. Report a **match %** (`100 − pct`) per page. **NOT a blocker** — benign font/dynamic diffs are expected; this is the confidence signal + the before/after proof. | **fidelity signal** (never a blocker) | `pixel.ts` `pixelDiff`; the `source-desktop.png` capture; the clone render |
| **seo** | SEO fundamentals per page + **SEO-element regressions** vs. source | Pure HTML parse of the **built** clone page: `<title>`, meta description, single `<h1>` + heading hierarchy, image `alt` coverage, `<link rel="canonical">`, JSON-LD / structured data, Open Graph + Twitter Card tags, `<html lang>`, robots meta + `sitemap.xml`/`robots.txt` presence. **Diff against the source `capture.json` head/tree:** an element present in source but absent in clone = **regression (blocker)**; a weak/missing element the source also lacked = informational (not a blocker). | **blocker** for a source→clone SEO regression; otherwise **informational** | source `capture.json` (`head`, `tree`) for the regression diff; the built `dist/` HTML |
| **pagespeed** (lightweight, v1) | Page weight + request/asset load | Report built **page weight (KB)** and **asset/request count** per page, plus the largest assets. Uses data already collected during build (`pageWeightKb`, `assetCount`). Pure, no extra tooling. | **informational** (never a blocker) | existing `pageWeightKb` / `assetCount` in the build report; `capture.json` assets |
| **pagespeed** (Lighthouse, v1.1 / opt-in) | Real Core-Web-Vitals + Lighthouse perf/a11y/SEO scores | Run **Lighthouse** headless against the served built `dist/` → LCP / CLS / TBT-style metrics + the performance/accessibility/SEO category scores. **Opt-in / heavy** — see Feasibility. | **informational** (never a blocker) | `lighthouse` npm (or PageSpeed Insights API) + a headless serve of `dist/` |

### The fidelity signal

Fidelity is deliberately **not** a pass/fail gate. Because fallback fonts and non-running dynamic features legitimately change pixels, a low match % is often *expected*, not *wrong* — a form that renders as a static shell will diff, and that's a note, not a blocker. So fidelity is reported as:

- **Overall fidelity %** — an aggregate (e.g. mean per-page match %) in the verdict bar, as a *confidence* number, not a threshold.
- **Per-page match %** with a **source-vs-clone before/after slider**, sorted **worst pages first** — the operator's eyes are the final judge; the report just points them at the pages most worth looking at.

The slider is the existing before/after component already in `report.ts` (inline CSS+JS, no deps), repointed at `source-desktop.png` (before) vs. the clone screenshot (after).

### Site health — SEO + PageSpeed

A section reporting the cloned site's **SEO and performance health**, distinct from visual fidelity. Two halves, deliberately of **different build cost**:

- **SEO (cheap, deterministic, high-value).** Pure parse of the built HTML per page for the fundamentals (title, meta description, H1 + heading hierarchy, `alt` coverage, canonical, JSON-LD, OG/Twitter, `lang`, robots/sitemap). Report presence/quality per page and flag gaps. **QA tie-in — the regression rule is explicit and load-bearing:** if the clone *dropped* an SEO element the *source* had (e.g. lost the meta description or JSON-LD during capture/projection), that is a **fidelity regression → a blocker** (the `seo` check emits it, the verdict counts it). If the SEO element is weak or missing *and the source lacked it too*, that's the source's own issue → **informational/actionable, never a ship-blocker.** The regression is *ours*; the shortcoming is the *gym's*.
- **PageSpeed (two tiers).**
  - **(a) Lightweight — ships in v1.** Page weight (KB), request/asset count, largest assets. We already capture `assetCount` / `pageWeightKb` during build; this is free.
  - **(b) Real — Lighthouse, opt-in / v1.1.** Actual performance + Core Web Vitals (LCP / CLS / TBT-style) and the Lighthouse accessibility/SEO category scores, run headless against the served `dist/`. **Honest feasibility (see Risks):** it's an added dependency (`lighthouse` npm, or the PageSpeed Insights API), adds meaningful build time, and needs a headless run against a *served* dist — so it is opt-in and may land in v1.1. The lightweight tier ships in v1 regardless.

PageSpeed (both tiers) is **informational** — it never blocks the verdict. Only an SEO *regression vs. source* blocks.

## Report structure (top to bottom)

The HTML is restructured around the **decision**, not the build. Order is fixed:

1. **Verdict** — `✅ SHIP` or `⚠ NEEDS FIXES (N blockers)`, plus overall fidelity % and page count. The one-glance answer, above the fold.
2. **Blockers punch-list** — each blocker as one row pinned to **page + location**, e.g.:
   - `/pricing — logo image 404`
   - `/ — hero — section empty`
   - `/ — nav — "Classes" link dead`
   - `/about — footer — overlaps content`
3. **Noted (won't block)** — font fallbacks and static forms/maps/etc., same page+location framing, visually de-emphasized so they never read as failures.
4. **Fidelity proof** — per-page **source-vs-clone** with match % and the before/after slider, **worst pages first.**
5. **Site health — SEO + PageSpeed** — SEO fundamentals per page (dropped-vs-source elements also surface as blockers up in the punch-list, not only here), plus the lightweight PageSpeed table (weight / asset count / largest assets) and, when run, Lighthouse scores.
6. **Cost & Speed** — a real section (not a footnote): per-page **and** aggregate build cost + speed. **Reuse the honest cold-vs-warm accounting already in `report.ts`** (per-page capture fresh/cached-est + project + build ms; per-page LLM label cost; aggregate cold-build total vs. this-run wall; total LLM $, $/page, and $/site projection). It ranks below the verdict, blockers, fidelity, and site health — but it is kept in full, because the operator genuinely wants build cost + speed visibility.

The report **leads with the QA decision** (verdict → blockers → notes → fidelity → site health); **Cost & Speed** lives at the bottom as its own full section, not a throwaway line.

## Persistence / schema

`build-report.json` is the admin-dashboard data contract; the redesign **extends** it (does not replace the file). The new inspection payload rides alongside the existing per-page data so the admin can render the same verdict/punch-list the HTML shows.

```ts
type Severity = "blocker" | "note";
type IssueKind =
  | "broken-asset" | "empty-section" | "dead-link" | "layout-break"   // blockers
  | "seo-regression"                                                  // blocker (dropped-vs-source)
  | "font-fallback" | "dynamic-feature";                              // notes

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

// SEO fundamentals parsed from the BUILT clone HTML, each tagged present/quality
// AND whether the SOURCE had it (droppedFromSource === true → a blocker regression).
interface SeoElement {
  present: boolean;
  droppedFromSource: boolean; // source had it, clone lost it → seo-regression blocker
  detail?: string;            // value/quality note (e.g. title length, alt coverage %)
}
interface PageSeo {
  page: string;
  title: SeoElement;
  metaDescription: SeoElement;
  h1: SeoElement;              // + heading-hierarchy quality in detail
  imageAlt: SeoElement;        // coverage % in detail
  canonical: SeoElement;
  jsonLd: SeoElement;
  openGraph: SeoElement;
  twitter: SeoElement;
  lang: SeoElement;
  robots: SeoElement;          // robots meta + sitemap.xml / robots.txt presence
}

interface PageSpeed {
  page: string;
  // Lightweight tier (v1) — from data already collected during build.
  pageWeightKb: number;
  assetCount: number;
  largestAssets: Array<{ url: string; kb: number }>;
  // Real tier (Lighthouse, v1.1 / opt-in) — absent unless Lighthouse ran.
  lighthouse?: {
    performance: number; accessibility: number; seo: number; // category scores 0-100
    lcpMs?: number; cls?: number; tbtMs?: number;            // core-web-vitals-ish
  };
}

interface PageInspection {
  page: string;
  issues: Issue[];         // this page's blockers + notes (incl. seo-regression)
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
  types.ts               # Issue, IssueKind, Severity, PageInspection, InspectionReport, PageFidelity, PageSeo, PageSpeed
  inspect.ts             # orchestrator: for each page → render clone once → run all checks → derive verdict
  checks/
    broken-assets.ts     # blocker — 0×0 imgs / failed bg-images + build-warning cross-ref
    empty-sections.ts    # blocker — source section non-empty but clone empty/absent
    dead-links.ts        # blocker — internal href/nav → no built route
    layout-breaks.ts     # blocker — box overlaps (reuses edit/verify overlap) across WIDTHS
    font-fallback.ts     # note    — computed font-family fell back
    dynamic-features.ts  # note    — forms / iframes / known widgets now static
    fidelity.ts          # signal  — pixelDiff source-desktop vs clone screenshot → match %
    seo.ts               # blocker-on-regression + informational — pure built-HTML SEO parse, diffed vs source capture head/tree
    pagespeed.ts         # informational — lightweight (weight/asset count/largest, pure) + optional Lighthouse (heavy, opt-in)
  verdict.ts             # pure: Issue[] → { verdict, blockerCount, blockers[], notes[] }
  index.ts               # inspect(site) → InspectionReport
```

- **`seo.ts` is a pure HTML parser** over the built `dist/` HTML, plus a diff against the source `capture.json` `head`/`tree`. It emits an `seo-regression` **blocker** only when the source had an SEO element the clone dropped; a shortcoming shared with the source is reported **informational**, never as a blocker. No browser, no network — cheap and deterministic.
- **`pagespeed.ts` has two independent paths.** The lightweight path is pure (reads the weight/asset data already gathered at build) and always runs in v1. The Lighthouse path is the heavy, **opt-in** path (gated behind an option/env flag) — it is the only part of the QA module that adds a dependency and needs a served `dist/`; it never blocks the verdict and can land in v1.1 without changing the schema (the `lighthouse` field is optional).

- **`inspect(assembledSite) → InspectionReport`** is the one public entrypoint. It renders each built page once (shared `renderSnapshot` on the clone `dist`), fans the render + source capture + route map out to each check, unions the issues, and calls the pure `verdict()`.
- **Reuse, don't reinvent:** the checks call into `pixel.ts` (fidelity), `edit/snapshot.ts` (`renderSnapshot`, `sectionListOf`), and `edit/verify.ts`'s overlap primitive. If the overlap primitive isn't already exported, promote it to a shared helper both `verify.ts` and `layout-breaks.ts` import — one implementation, two callers (leverage: the never-regress overlap logic and the QA overlap check can never drift).
- **`report.ts` — RESTRUCTURE, not rewrite the shell.** Keep the self-contained inline-CSS/JS HTML approach, the existing before/after slider, **and the existing honest cold-vs-warm cost accounting** (per-page capture fresh/cached-est + project + build ms, LLM label cost, cold-build-total-vs-this-run-wall, $/page, $/site — all already in `report.ts`, reused verbatim). Change the *content order* to verdict → blockers → notes → fidelity → site health → Cost & Speed. `generateHtmlReport` takes the extended `BuildReport` (now carrying `inspection`) and renders the new structure; the cost math is repositioned, not deleted.
- **Wire into `buildSite`:** after `full-site/` is assembled (`orchestrate.ts`), call `inspect(fullSite)` → attach `inspection` to the `BuildReport` → `generateHtmlReport`. The Inspector runs on the **assembled, built** output (real `dist/`), because that's what actually ships — inspecting anything earlier would miss build-stage breakage.

## The ONE thing to prove

**On a real cloned site, the report produces a correct, trustworthy verdict and an actionable punch-list** — it catches a real broken asset (blocker), flags a static form (note, not a blocker), and shows per-page fidelity with the worst page surfaced first. Concretely, the acceptance bar:

- A blocker the operator would agree is a blocker (e.g. a genuinely 404'd logo) appears in the punch-list, pinned to the right page + location, and flips the verdict to `NEEDS FIXES`.
- An expected static-clone divergence (a booking form that can't run, a fallback font) appears **only in Notes** and does **not** flip the verdict.
- An SEO element the **source had and the clone dropped** (e.g. a lost meta description or JSON-LD) appears as a **blocker** and flips the verdict; a weak-SEO element the source **also lacked** appears **informational only** and does **not** flip it.
- Fidelity renders the source-vs-clone slider, worst page first, with a believable match %.
- The Cost & Speed and Site Health sections render below the QA decision with real per-page + aggregate numbers.

If the verdict and punch-list are correct and actionable on a real clone, the report has done its job. This is the never-regress rule (`DOCTRINE.md`, `feedback_never_regress_html_eval`) applied to the *report itself*: it must make the ship/no-ship call as well as a careful human eyeballing the clone would.

## Risks

The dominant risk is the classic QA-gate failure mode: **a gate that cries wolf or misses real breaks is worse than no gate at all.** Each check is a small unit precisely so its false-positive/false-negative behavior can be pinned individually.

- **False positives (crying wolf) → operators stop trusting the verdict.**
  - *broken-assets:* lazy-loaded / below-the-fold images may report 0×0 before they load. Mitigation: use `renderSnapshot`'s existing settle/wait behavior; only flag after the page has settled; treat truly-never-loaded as the blocker.
  - *empty-sections:* a section legitimately shorter in the clone (a collapsed dynamic list) can look "empty." Mitigation: require a non-empty **source** signal AND a near-zero **clone** signal, with a content floor, not a strict equality.
  - *layout-breaks:* the 1–2px seam tolerance already tuned in `verify.ts` must be reused verbatim; sticky/fixed/absolutely-positioned overlays legitimately overlap and must be excluded from the overlap set.
  - *dead-links:* trailing-slash / index-route normalization must match `buildSite`'s own link map exactly, or every link false-fails. Reuse `links-site.json`, don't re-derive routes.
- **False negatives (missing real breaks) → the gate ships a broken site.**
  - *broken-assets:* a CSS `background-image` 404 renders as blank, not 0×0 — the render-only check can miss it; this is why the check **cross-references build-time asset-resolution warnings**, catching what the render alone can't.
  - *dynamic-features vs. empty-sections boundary:* a form that fails to render at all (empty section) vs. one that renders static (note) must be disambiguated correctly, or a real break gets mislabeled a benign note.
- **Fidelity misread as a gate.** Someone could wire the fidelity % into the verdict; that would immediately cry wolf on every clone with a fallback font. It is, by design, a signal only — this must stay true.
- **SEO check over-blocking.** The blocker is *specifically* a source→clone regression, not weak SEO. If `seo.ts` ever blocks on a merely-missing element the source also lacked, the gate cries wolf on the gym's own SEO gaps. The regression diff (present-in-source, absent-in-clone) is the guard; the source-side comparison must be robust (e.g. a source meta description present but empty vs. genuinely absent). PageSpeed must **never** contribute a blocker — it is informational by construction.
- **Lighthouse feasibility (the real PageSpeed tier).** Honestly: Lighthouse is (a) an added dependency (`lighthouse` npm, or the PageSpeed Insights API — network + quota), (b) meaningfully slow (headless run, multiple passes) — it would materially extend build time on every page, and (c) needs a **served** `dist/` (a local static server the run points at), not just files on disk. For those reasons it is **opt-in / v1.1**, gated behind a flag; the lightweight tier (weight/asset count, free from build data) ships in v1 and covers the common "is this page heavy" question without any of that cost. The schema already makes `lighthouse` optional so shipping it later is non-breaking.
- **Detectors of genuinely uncertain reliability (flagged honestly, not hand-waved):**
  - **`dynamic-features` widget recognition** is the least deterministic check. Forms (`<form>`) and iframes are reliable structural signals. **Known booking/chat/video widget signatures are inherently a maintained allow-list** — a widget we don't recognize won't be flagged (false negative), and a heuristic match could over-flag (false positive). v1 should lean on the strong structural signals (`<form>`, `<iframe>`, the `NO_REHOST` set from `capture.ts`) and treat named-widget recognition as a best-effort layer. Because it's a **note**, a miss here degrades gracefully (an un-flagged static widget), unlike a blocker miss.
  - **`font-fallback`** depends on detecting that a computed family resolved to a fallback rather than the intended face. Distinguishing "loaded the brand font" from "fell back to a same-named system font" is not always crisp across platforms; this is why it's a **note**, not a blocker — a wrong call here is low-cost.
  - **`empty-sections` content floor** is a tuned threshold; it will need calibration on real clones to sit between "collapsed-but-fine" and "genuinely empty." The unit test fixtures must include both sides of that line.

## Out of scope (explicit YAGNI)

- **Auto-fixing** any blocker. The Inspector reports; fixing is a separate edit-op flow (subsystem C). The report is a gate, not a remediator.
- **The heavy Lighthouse PageSpeed tier in v1.** SEO fundamentals + the lightweight PageSpeed tier (weight/asset count) ship in v1; the real Lighthouse run (perf/CWV/a11y/SEO scores) is **opt-in / v1.1** for the feasibility reasons in Risks. (SEO + lightweight speed are *in* scope — only the Lighthouse dependency is deferred.)
- **General site-quality opinions beyond source fidelity + SEO fundamentals.** The QA report is not a marketing/CRO audit; SEO here is fundamentals + regression-vs-source, not a growth recommendation engine (that's the keyword-brain's job).
- **Cross-page / whole-site semantic checks** beyond internal-link resolution (e.g. "is the messaging consistent"). Per-page structural + visual + SEO fidelity only in v1.
- **Content-correctness judgment** ("is this the right copy"). The Inspector checks that what the source had, the clone has — not whether the source was any good.
- **Blocking the build.** `buildSite` still produces `full-site/`; the Inspector annotates it with a verdict. The *operator* decides not to ship; the engine doesn't refuse to assemble. (A future admin gate could refuse deploy on `needs-fixes`, but that's the admin's policy, not the engine's.)
- **Replacing the pixel oracle** (`project.ts` 0-px baseline). That proves the *projection* is lossless; the Inspector's fidelity proves the *built clone resembles the live source*. Different jobs; both stay.

## Self-review

- **Placeholders:** none. Every check names concrete existing machinery it reuses (`pixel.ts`, `edit/snapshot.ts`, `edit/verify.ts` overlap, `capture.json` head/tree, `links-site.json`, `source-desktop.png`, `WIDTHS`, `pageWeightKb`/`assetCount`, astro-build stderr). The only *new* dependency is Lighthouse, and it is explicitly opt-in / v1.1, not a placeholder.
- **Consistency with the codebase:** the module layout mirrors `src/edit/` (orchestrator + per-unit files + `types.ts`); the report stays self-contained inline-HTML per the existing `report.ts` convention; `build-report.json` is *extended* additively (the admin contract note in `report.ts` is honored — shape isn't broken, only widened with `inspection`).
- **Consistency with approved decisions:** verdict = pragmatic ship/no-ship; the blocker/note split matches the owner's table (assets, empty sections, dead links, layout, **SEO-regression** = blockers; fonts, dynamic features = notes; PageSpeed always informational); full Inspector scope in v1; report leads with the QA decision (verdict → blockers → notes → fidelity → **site health** → **Cost & Speed as a real section**); fidelity is a signal, never a gate; SEO blocks **only** on a dropped-vs-source regression; Lighthouse is the honest heavy/opt-in tier. None re-opened.
- **Scope:** additive to `buildSite`; does not touch the projection oracle, the edit subsystem's verifier semantics, or the capture pipeline (only *reads* its outputs). `report.ts` content is restructured; its HTML-shell + before/after-slider conventions are preserved. Cost & Speed is retained in full (not dropped), just ranked below the QA decision. Earlier-draft contradiction resolved: SEO + lightweight PageSpeed are **in** scope; only the Lighthouse dependency is deferred.
- **Ambiguity honestly flagged:** the genuinely-uncertain calls are the `dynamic-features` named-widget allow-list, `font-fallback` cross-platform detection, the `empty-sections` content floor, and the **`seo.ts` source-side comparison** (present-but-empty vs. genuinely-absent) — all in Risks. The three note-severity ones degrade gracefully; the SEO one is guarded by making the *regression* (not the shortcoming) the sole blocker trigger, and Lighthouse's cost is called out as its own feasibility risk rather than hidden.
