# D — Subsystem D: Page Model (types + goals)

**Date:** 2026-08-02
**Status:** Approved design — proceeding to implementation
**Engine:** `packages/clone-engine/` · Doctrine: `packages/clone-engine/DOCTRINE.md`
**Depends on:** Plan 2 (A+B) — `site.json` manifest, `data-*` attribute contract, `src/types.ts`
**Consumed by:** C (addPage), E (section generation respects page goal), F (measurement reads goal)

---

## Purpose

Pages become first-class, typed, goal-bearing objects. A page's type and goal are:

1. Machine-addressable in `site.json` (`ManifestPage.type` + `ManifestPage.goal`)
2. Rendered as `data-page-role` + `data-goal` on the page root (`<body>`)
3. Set at projection time via a pure route-pattern classifier (`classifyPage`)
4. Optionally overridden in `addPage` via an explicit `pageType` parameter

The A+B spec reserved `data-page-role` / `data-goal` for exactly this; this spec fulfills that reservation.

---

## The ONE thing to prove

A page's type + goal are machine-addressable in `site.json` AND rendered as `data-page-role` / `data-goal` attributes on the `<body>` — without moving a single pixel (pixel parity oracle stays 0-px; attributes on `<body>` are render-neutral).

---

## Page-type taxonomy

| Type | Routes (heuristic) | Meaning |
|---|---|---|
| `home` | `/` | Root entry point — one per site |
| `pillar` | `/about`, `/programs`, `/coaches`, `/services`, `/nutrition`, `/team`, and anything not matched by a more-specific type | Core "learn about us" pages |
| `content` | `/blog/*`, `/news/*`, `/recipes/*`, `*-spotlight*`, `*-story*` | User-generated / editorial content |
| `conversion` | `/pricing`, `/membership*`, `/join*`, `/contact*`, `/schedule*`, `/book*`, `/trial*` | Act pages — goal is to get the visitor to do something |
| `utility` | `/privacy*`, `/terms*`, `/legal*`, `/sitemap*`, `/search*` | Legal / nav / infrastructure pages |

**Decision: `pillar` is the catch-all.** Anything that doesn't match a more specific pattern defaults to `pillar/inform`. This is safer than `unknown` — most gym pages (about, services, coaches) are informational pillars.

---

## Goal mapping

Each type has a default goal. Goal is a SEPARATE field (not derived from type at read time) so it can be overridden independently if needed.

| Type | Default goal | Meaning |
|---|---|---|
| `home` | `orient` | Introduce, orient, navigate |
| `pillar` | `inform` | Educate about the gym / offering |
| `content` | `engage` | Keep readers reading; build trust |
| `conversion` | `convert` | Drive a signup / booking / contact |
| `utility` | `none` | No measurable engagement goal |

The constant `GOAL_OF_TYPE` exports this mapping. An LLM refinement pass (F) may override `goal` per-page in future; this spec does not build it — heuristic is sufficient for v1.

---

## Manifest extension

`ManifestPage` gains two new required fields:

```ts
type: PageType;   // "home" | "pillar" | "content" | "conversion" | "utility"
goal: PageGoal;   // "orient" | "inform" | "engage" | "convert" | "none"
```

`buildManifest` calls `classifyPage(route)` to populate them. `addPage` in `ops.ts` may override `type` (and derives `goal` from it) via an optional `pageType?: PageType` parameter.

---

## Data-attribute contract

The page root (`<body>`) carries:

```html
<body class="p42" data-page-role="conversion" data-goal="convert">
```

- `data-page-role` = the `PageType` string
- `data-goal` = the `PageGoal` string
- These are ADDITIVE — they sit alongside existing `class="pN"` and any other attrs
- Render-neutral — attributes on `<body>` are invisible to the pixel oracle

Downstream consumers:
- **C** — edit ops can respect type conventions (e.g. a conversion page's hero probably has a CTA)
- **F** — measurement reads `data-goal` from the live DOM to know what to instrument

---

## Classifier (`src/pagemodel.ts`)

Pure function — no file I/O, no browser, trivially testable.

```ts
classifyPage(route: string): { type: PageType; goal: PageGoal }
```

Route matching order (first match wins):

1. Exact `/` → `home/orient`
2. `/blog/`, `/news/`, `*-spotlight*`, `*-story*`, `/recipes/` → `content/engage`
3. `/pricing`, `/membership*`, `/join*`, `/contact*`, `/schedule*`, `/book*`, `/trial*` → `conversion/convert`
4. `/privacy*`, `/terms*`, `/legal*`, `/sitemap*`, `/search*` → `utility/none`
5. Else → `pillar/inform`

The function normalizes the route (lowercase, strips trailing slashes) before matching. `GOAL_OF_TYPE` is exported as a const map for callers that need the default mapping without a route.

---

## Implementation files

| File | Change |
|---|---|
| `src/types.ts` | Add `PageType` + `PageGoal` string unions; add `type: PageType` + `goal: PageGoal` to `ManifestPage` |
| `src/pagemodel.ts` | NEW — `classifyPage` + `GOAL_OF_TYPE` |
| `src/manifest.ts` | Call `classifyPage(route)` in `buildManifest`; set `type` + `goal` on the page entry |
| `src/project.ts` | Emit `data-page-role` + `data-goal` on `<body>` in both the static `index.html` and the Astro `src/pages/index.astro` |
| `src/edit/types.ts` | Add `pageType?: PageType` to the `addPage` EditOp variant + EditOpSchema |
| `src/edit/ops.ts` | `addPage` accepts optional `pageType`; uses it (or classifies from route) to set `type`+`goal` on the new manifest page and emit attrs in the page `.astro` file |
| `test/pagemodel.test.ts` | NEW — unit tests for `classifyPage` + `GOAL_OF_TYPE` |
| `test/edit/ops.test.ts` | Extend addPage tests: type+goal in manifest, data-attrs on body |
| `test/semantic.test.ts` | Add assertion: projected page body carries `data-page-role` + `data-goal` |

---

## Never-regress invariant

- Pixel parity oracle: `data-page-role` / `data-goal` are attributes on `<body>` — render-neutral in all browsers. Oracle must stay 0-px.
- The 190 existing edit tests must stay green (addPage signature change is backward-compatible: `pageType` is optional).
- `tsc --noEmit` must be clean — the new union types are string literals, not enums, so no runtime overhead and no import ceremony.

---

## Concerns for E (section generation) and F (measurement)

- **E (section generation):** `page.goal` gives the section generator context — a `conversion` page should prefer CTA-heavy sections; a `content` page prefers text-heavy. E should read `page.goal` from `site.json` before picking section templates.
- **F (measurement):** `data-goal` on the live `<body>` is the primary machine hook for F's instrumentation — F reads it from the DOM and maps it to a tracking event schema. The five goal values (`orient/inform/engage/convert/none`) should be treated as a stable contract that F depends on; do not rename them in a backward-incompatible way.
- **Admin side:** `ManifestPage.type` + `.goal` are surfaced in the site digest (via `SiteDigest`/`DigestPage`) — the admin side and planner LLM can read the type/goal from the digest without re-parsing the DOM.
