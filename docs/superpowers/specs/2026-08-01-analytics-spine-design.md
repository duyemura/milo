# Analytics Spine — GSC · GA4 · GBP Insights (zero-touch for gyms)

**Date:** 2026-08-01
**Status:** Design — attacking under Dan's directive (2026-08-01)
**Owner:** admin-side session · **Consumer:** keyword-brain (calibration), veteran digest (proof layer), engine F (goals)

## The rule

**Gyms take zero actions.** PushPress provisions, injects, verifies, and measures from
its own side. The only Google entity a gym ever touches is ONE optional OAuth link for
their Business Profile (GBP), presented as a single chat/upgrade action — never a
configuration task.

## Why three signals, in this order

| Signal | Question it answers | Owner action |
|---|---|---|
| **GSC** (Search Console) | Are we *discoverable*? queries, impressions, position, clicks — calibrates keyword briefs | zero (PushPress-hosted domains auto-verify) |
| **GA4** | Did visits become *conversions*? (CTA clicks, trial intent) | zero (property provisioned under our GA4 account, gtag injected at build) |
| **GBP Insights** | Local-pack conversions: calls, direction requests, photo views | **one optional OAuth click** (inherently per-gym permission) |

## Architecture

`packages/measurement` (one package, three modules + one auth adapter) — the only place
Google-credentials live. All I/O injected (`fetch` fakes in tests; no live HTTP in CI).

```
googleAuth    service-account JWT→token (GSC/GA4) + OAuth-token storage (GBP)
gsc           ensureProperty(siteUrl) → verify(meta-tag, via Verification API)
              → fetchQueries(siteUrl, {last N days}) → structured rows
ga4           ensureProperty() via Admin API → measurementId
              injectGtag(html, measurementId) — deterministic, idempotent
gbp           connectUrl(siteId) (OAuth link, admin hands to owner via chat)
              → fetchInsights(locationId) (v1 scaffold; live after first connect)
```

## Zero-touch mechanics (the hard part)

- **GSC ensure-property:** PushPress-hosted domains (staging subdomains now; production
  custom domains as they land) are provisioned by the Search Sites API and verified with a
  meta tag the module injects into the site's own HTML head at build time — then
  `siteVerification.verify` is called server-side. No owner in the loop because WE serve
  the page. Custom-domain-not-on-our-DNS sites: property prepared, verification parked in
  `pending` with a chat nudge if a gym ever hosts their own domain (v1 doesn't).
- **GA4 ensure-property:** Admin API from our workspace service account creates one
  property per site (named `<slug>`); the measurement ID rides `google_connections` and is
  injected into every dist HTML at build/deploy time (post-build transform, both seeds —
  no emitter changes required anywhere).
- **GBP:** the API fundamentally requires gym-side permission. `gbp.connectUrl` renders as
  a single chat suggestion ("Connect your Google business — one link") + a dedicated
  suggestion card; after OAuth consent, metrics flow automatically thereafter.

## Data model (migration 5)

- `google_connections` (siteId, kind gsc|ga4|gbp, externalId (measurementId/propertyUrl/locationId), status (pending|active|error), meta json, createdAt, updatedAt)
- `site_metrics` (siteId, source, metric, dimensions json, value, collectedAt)
- Job type extension: **`measure`**, **`verify-gsc`** folded into measure (idempotent).

## Digest + calibration loop

The veteran digest gains a proof section ("'personal trainer torrance' impressions went
0 → 34 in 14 days"). `packages/keyword-brain` scoring optionally reads recent GSC rows to
mark briefs `validated=true` and re-rank novelty downward for intents already winning.
GBP + GA4 numbers join the same digest when present.

## Prerequisite (PushPress-side, once — NOT per gym)

A Google Cloud project with: Google Search Console API, Sites/site-verification API,
GA4 Admin API, Business Profile APIs; one service-account JSON (env
`GOOGLE_SERVICE_ACCOUNT_JSON`), and one master GSC account linked. Dan owns this once for
the org; module works fully offline in tests without it.

## Error handling

Missing service account → modules run in "scaffold mode": inject + tables + digest sections
still work (metrics rows are just absent); jobs log the precise missing prerequisite, never
fail the build path. GA4 injection is idempotent (run N times = one gtag block).

## Out of scope (v1)

AEO layer, ads APIs, multi-domain GSC rollups, custom event taxonomy beyond auto + CTA
events, GBP posting automation (separate feature on this spine's auth).
