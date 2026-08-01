# Keyword Brain — Local Marketing Engine (v1)

**Date:** 2026-08-01
**Status:** Design — approved by Dan (2026-08-01, "design and build as part of admin; chat-first + UI")
**Owner:** admin-side session · **Contract consumer:** engine session (see `project_milo_keyword_brain` memory)

## Purpose

Replace the first function of a local marketing professional for a gym: **find the
searches locals actually make, and turn them into page briefs the site builder can build.**
The ICP (busy owner, no budget, no expertise) gets a typed, veteran-voiced answer to
"what should my site's pages target?" — fully automated, chat-drivable, UI-visible.

Follow-ons (not this project): GMB automation, review engine, GSC measurement.

## Decisions (from brainstorming)

- **Autonomy:** on-demand job now; same job shape schedules later (cron line).
- **Keyword data:** Google Autocomplete mining + `llmJson` intent/fit scoring. No paid API.
- **Ownership seam:** this session owns the brain; engine session owns page building (D/E)
  and consumes briefs via the **PageBrief handshake** (schema + DB + JSON drop).

## Package: `packages/keyword-brain`

Five typed stages, injected I/O (fake fetch/chat in tests, no live HTTP in CI):

| Stage | What |
|---|---|
| `discover` | Build gym context: company name, city/state (from last seed-job payload), activities + differentiators via `llmJson` (site URL/name/content hints) |
| `research` | Autocomplete mining: `<activity> <city>`, `<activity> <neighborhood>`, `<activity> near me`, `<activity> classes <city>`; suggestion pools, browser-headered fetch, 8s timeout, in-run cache |
| `score` | `llmJson` over pools: intent (transactional/informational), fit vs offerings, effort, novelty → dedupe (case/punct-insensitive) + cluster → top N clusters (default 12) |
| `brief` | One `PageBrief` per cluster (Zod-validated, retry via llmJson) |
| `report` | A veteran-voiced digest string (LLM-written from results, not templated buzzwords) |

## PageBrief (handshake contract, Zod from the package)

```
siteId, companyId, keywordCluster, primaryKeyword, secondaryKeywords[],
intent: "transactional" | "informational", suggestedUrl, pageType ("local-landing" v1),
goal, outline: { role, notes }[], differentiators[], localSignals[],
status: "pending" | "accepted" | "built" | "dismissed"
```

Delivery: (1) `page_briefs` table (source of truth) (2) JSON drop
`DATA_DIR/briefs/<siteId>.json` re-emitted every run (3) admin surfaces below.
Engine session imports the Zod schema as a workspace dep.

## Admin integration

- **Job type `keyword-cycle`** — same per-site serialization, logs, failure handling as all engine jobs. Package consumed as a workspace library (admin-side code, no CLI boundary needed).
- **`jobs.result` column (migration 4 with `page_briefs`)** — stores the digest text.
- Routes: `GET /api/v1/sites/:id/briefs`, `PATCH /api/v1/briefs/:id` ({status}), `GET /api/v1/briefs/:id` (full outline).
- Chat action **`runKeywordCycle {site}`** (intent schema + rule fallback "keyword work for X") + SYSTEM vocabulary; suggestions derivator gains "N page briefs ready for <company>" cards.
- UI: site detail **Briefs** tab (cluster, kw chips, intent badge, suggested URL, goal, expandable outline, dismiss), counts on the card; job rows render `keyword-cycle` generically.

## Out of scope (v1)

Page authoring (engine's E), GSC measurement (auth connect later), scheduling, auto-accept of briefs, paid keyword volumes, batch/fleet anything (per-site only — scope guardrail).

## Error handling

Autocomplete failures → pool subset with a logged note (not fatal). LLM schema failures → llmJson retries, then cluster dropped (logged), never invented keywords. No city/state derivable → run fails loudly in logs (never guesses a location). Empty surviving clusters → job succeeds with digest saying so.

## Testing

- Package tests: fake fetch (scripted autocomplete responses) + fake chat → full cycle, dedupe/cluster proof, schema roundtrip, no-LLM-failure paths.
- Admin tests: job runner wiring (stub engine), brief routes + status patch, suggestion count, chat `runKeywordCycle` effect.
- Live smoke: one real Torrance run (network to autocomplete + OpenRouter only; no shared infra).
