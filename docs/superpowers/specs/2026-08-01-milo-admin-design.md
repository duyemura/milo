# Milo Admin — Internal Control Plane for Client Sites

**Date:** 2026-08-01
**Status:** Design — approved in brainstorming, pending written-spec review
**Owner:** the admin-side session (see `project_milo_unified_vision` memory)
**Shared contract:** the A+B substrate — `docs/superpowers/specs/2026-08-01-llm-safe-semantic-representation-design.md`

## Purpose

One hosted internal app where the PushPress team **creates, views, edits, deploys, and
administers client websites** across the full fleet (~2000 sites). The full control plane is
designed up front; functionality is built in phases. Every mutating surface is an API
endpoint from day one so **PushPress Core can later chat-edit client sites through the same
API** the admin SPA uses.

This session owns the admin/control surface only. Engine work (page-clone, template seed,
A–F subsystems) is owned by the other session; the admin reaches engines exclusively
through the A+B contract and typed CLI entrypoints.

## Key decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Form factor | **Hosted web app**, WorkOS AuthKit (hosted login, `@pushpress.com` domain enforced server-side) | SSH TUI idea rejected: still requires a hosted server, needs key/token distribution, and can't show the *visual* artifacts (screenshots, previews, diffs) this admin exists to manage. WorkOS chosen over raw Google OAuth (2026-08-01): managed AuthKit login UI + CLI-provisioned envs, zero OAuth plumbing for us. Local dev = all-pass `AUTH_MODE=dev`, no external anything. |
| Scope | **Full control plane**, phased | Registry, jobs, chat-edit, deploy, brand/structure inspection, platform API. Built in 4 phases (below). |
| Editing model | **Chat-only** | One editing path for team and clients, forever. Admin is a thin UI over engine edit ops (doctrine subsystem C); no form-based editing to build or maintain. |
| Placement | **`apps/admin` in the milo repo** | NOT a `fastify-app-template` standalone app (Dan, confirmed). The admin orchestrates engines living in this monorepo; pnpm workspaces give it app-shaped boundaries. |
| Job queue | **BullMQ + Redis** | House stack; Redis is already provisioned everywhere. Worker runs in-process in monolith mode locally, `SERVICE=worker` processes in deployment. |
| Datastore | **Kysely**, SQLite locally → **Postgres** in deployment | Fleet scale (2000 sites) and multi-worker durability demand Postgres; Kysely dialect swap keeps one codebase. |
| Engine code | **TypeScript only** | Dan, 2026-08-01: no production surface may run untyped `.mjs`. Clone triggers are **gated on the page-clone TS port** (other session, consolidation work). Admin never imports engine internals — engines are typed executables behind the A+B contract. |

## Architecture

```
apps/admin/
  src/
    server/            # Fastify 5, SERVICE=api|worker|monolith
      routes/          # Zod + fastify-zod-openapi → /api/v1/*
      auth/            # Google OAuth, hd=pushpress.com; scoped API keys (phase 4)
      jobs/            # BullMQ queue definitions + worker processors
      db/              # Kysely client (sqlite | postgres), migrations
      engines/         # command table: spawn typed engine executables
    web/               # React 19 + Vite + @pushpress/pushpress-ui + TanStack Query v5
  package.json
```

- **Process modes** follow the platform convention: `SERVICE=api` (HTTP),
  `SERVICE=worker` (BullMQ processors), `SERVICE=monolith` (default for local dev).
- **Engines run as BullMQ jobs** that spawn typed executables (`milo` CLI now; the
  TypeScript page-clone binaries when ported). Job logs stream job → Redis → UI.
- **Per-site job serialization (concurrency invariant):** at most **one active engine job
  per site** at any time. Multiple teammates chat-editing or triggering jobs on the same
  site queue in order; they never interleave. Enforced at dispatch (BullMQ group keyed by
  `siteId`, or an equivalent active-job-per-site mutex). Deploy/rollback jobs for a site
  also take the lock — no deploy mid-build. UI shows queue position for waiting jobs.
- **Nothing durable on the host disk.** Captures/builds are per-run ephemeral workspaces;
  durable state = Postgres/SQLite (registry, jobs, sessions, deploys) + S3 (deployed sites,
  screenshots, asset bundles — the deploy layer already writes there).

## Multi-tenancy

Three-level hierarchy, each level its own boundary:

```
workspace (client org — the sandbox) → companies (gyms/businesses) → sites
```

- **Workspace** = the client organization and the **sandboxed boundary**. One owner
  (e.g. a franchisee) may run several gyms; they get ONE workspace containing all of them.
  Phase-4 platform API keys are scoped to a workspace: that client sees only their own
  companies/sites. Never cross-workspace. (Where PushPress models org/account ownership,
  the workspace links to it; that mapping is a phase-4 detail.)
- Every table carries `companyId` (the PushPress company) AND `workspaceId`. Queries
  always filter by both; job payloads carry both. Cross-gym and cross-workspace access are
  never possible — platform multi-tenancy rules apply unchanged.
- Team members (Google OAuth) see across all workspaces; workspace scoping only binds
  client-facing credentials.

## Data model

All Zod schemas mirrored in Kysely types; migrations per deployment dialect.

| Table | Key fields | Notes |
|---|---|---|
| `workspaces` | `id`, name, contact, status, pushpressAccountRef (nullable) | The client org — the sandboxed boundary. One owner, many gyms. |
| `companies` | `id`, `workspaceId`, `companyId`, name, status | One gym/business = one PushPress company. |
| `sites` | `id`, `workspaceId`, `companyId`, seedType (`clone` \| `template`), sourceUrl, slug, status, astroProjectRef | A company may have multiple sites over time (reseed). One is `active`. |
| `jobs` | `id`, `workspaceId`, `companyId`, `siteId`, type, payload, status, logsRef, startedAt/finishedAt | Backed by BullMQ; row is the durable record + API surface. |
| `edit_sessions` | `id`, `workspaceId`, `companyId`, `siteId`, actor (team user \| api key), messages[] | Chat history per site; each accepted edit links to a job. |
| `deploys` | `id`, `workspaceId`, `companyId`, `siteId`, version, env (staging \| production), url, screenshotRef, status, rolledBackFromId | Rollback = deploy a prior version (delegates to `packages/publish`). |

## API (v1 boundary)

All routes Zod-validated and OpenAPI-generated via `fastify-zod-openapi` (house pattern).
Two auth modes, deliberately only two principals — **no RBAC**:

| Principal | Auth | Sees | Controls |
|---|---|---|---|
| **Team member** | WorkOS AuthKit hosted login; sealed session cookie; server enforces `@pushpress.com` | all workspaces/companies/sites | everything |
| **Client API key** | opaque key, one per workspace (phase 4; team issues/rotates) | only that workspace's companies/sites | that workspace only |

Access control = tenant filtering, not a permission system: client-key requests are scoped
by `workspaceId` (never trusted from the client), team requests are unscoped. If a genuine
third actor ever appears (read-only staff, per-gym delegation), it slots into the auth
middleware and `actor` field without a data-model change — RBAC is deferred, not blocked.

```
GET    /api/v1/workspaces                   # client orgs; filter/search (client-scoped keys see only their own)
POST   /api/v1/workspaces                   # create client org
GET    /api/v1/workspaces/{id}              # detail: companies, aggregate status

GET    /api/v1/companies                    # gyms; filter by workspace/status
POST   /api/v1/companies                    # register a PushPress company (companyId link) into a workspace
GET    /api/v1/companies/{id}               # detail: sites, recent jobs, deploy status

GET    /api/v1/sites/{id}                   # detail: status, pages, preview/deploy links
POST   /api/v1/sites                        # create site: { clientId, seedType, sourceUrl?, templateId? }
POST   /api/v1/sites/{id}/jobs              # trigger: seed | build | deploy | rollback
                                            #   → 202 with job id + queue position (per-site lock)
GET    /api/v1/sites/{id}/jobs              # job list + status, waiting jobs include queue position
GET    /api/v1/jobs/{id}/logs               # streaming log (SSE)

POST   /api/v1/sites/{id}/edits             # chat edit: { message } → job (agent → build → deploy)
GET    /api/v1/sites/{id}/edits             # chat history + resulting jobs/preview links

GET    /api/v1/sites/{id}/brand             # brand.json read view (phase 3)
GET    /api/v1/sites/{id}/structure         # site.json read view (phase 3)
```

`POST /sites/{id}/edits` is deliberately the ONLY editing surface — the same endpoint
PushPress Core chat will call. No form endpoints, ever.

## Engine contract (the anti-spike-coupling boundary)

The admin treats each engine as an entry in a **command table**: an executable path +
arguments + expected outputs on the A+B substrate (`site.json`, `brand.json`, semantic
components). It never imports engine internals.

| Engine | Seed | Status | Admin support |
|---|---|---|---|
| `milo` CLI (intake/generate/build/publish) | template | TS, typed, tested | Phase 1 |
| page-clone binaries (TS port) | clone | **gated on TS port** (other session) | Appears when ported; zero admin rework |

Deploy + rollback delegate to `packages/publish` (versioned S3+CloudFront), not the spike's
`deploy.mjs` — per the consolidation plan, v2's publish is the capable one.

## Phasing

1. **Ops dashboard** — registry, statuses, run triggers, job log viewer, preview links +
   thumbnail screenshots, deploy/rollback. Template seed end-to-end; clone triggers gated
   on engine TS port. *This alone makes the team productive.*
2. **Chat edit** — per-site chat pane on `/edits`; each edit = a job (agent → build →
   deploy) with before/after preview links.
3. **Brand + structure inspector** — read views over `brand.json` and `site.json`
   (colors, fonts, sections, pages). Informational; chat covers edits.
4. **Platform API** — scoped API keys (one per **workspace** — a franchisee's key reaches
   all their companies and nothing else), per-workspace auth context, events for Core. The
   seam PushPress Core chat plugs into.

## Deployment

**Remote testing/showcase: Railway** (decided 2026-08-01) — one Node service + Postgres +
Redis plugins, git-push deploys, HTTPS URL included. Long-term home: PushPress K8s.

Env at deploy: `DATABASE_URL`, `REDIS_URL` + `QUEUE_DRIVER=bullmq`, `AUTH_MODE=workos` +
`WORKOS_API_KEY`/`WORKOS_CLIENT_ID`/`WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI` set to the
production URL (cookie `secure` flag derives from its scheme automatically). One manual step:
`workos config redirect add https://<prod-url>/auth/callback`.

## Out of scope (explicit YAGNI)

- Form-based editing of any kind.
- Granular RBAC / roles / permissions — two principals only (team, client key). Deferred,
  not blocked (see API section).
- Distributed-fleet autoscaling or worker management UI (scale workers via boring ops).
- Consolidation of engines into one codebase (other session's work; the command table
  absorbs it).
- Customer auth / customer-facing UI (PushPress Core owns both; we expose API keys).
- Serving site traffic (static sites live on S3 + CloudFront; the admin never proxies them).

## Error handling

- Job failures surface as `failed` status + full logs; no silent job swallows (BullMQ
  retries are explicit per-queue config, visible in the UI).
- Engine non-zero exit = job failure with stderr captured.
- OAuth failures deny with a clear "not a @pushpress.com account" state.
- Schema validation rejects bad payloads with Zod detail (fastify-zod-openapi shape).

## Testing

- Vitest for routes/jobs (injected DB + queue fakes; no live HTTP/S3/Playwright in CI),
  `--no-file-parallelism`.
- Route tests against the OpenAPI-generated schemas.
- Engine command-table tested against a stub executable, never the real engines.
- Playwright E2E for the dashboard's happy path (phase 1 exit criteria).
- Eval rule (`feedback_never_regress_html_eval` memory): admin work must never regress
  any website/HTML output — engine evals stay the other session's gate; admin changes
  touching render paths re-run the 0-px oracle.
