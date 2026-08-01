# Milo Admin — Phase 1 (Ops Dashboard) Implementation Plan

> **For agentic workers:** implements Phase 1 of `docs/superpowers/specs/2026-08-01-milo-admin-design.md`.
> Executed inline by the admin-session Claude (Dan out 1h; wants first working admin panel on return).

**Goal:** a bootable `apps/admin` where the team can list workspaces→companies→sites, create them,
trigger seed/build/deploy/rollback jobs (template seed via the typed `milo` CLI), and watch job
status + logs — all behind a dev/team auth boundary, per-site job serialization enforced.

**Architecture:** Fastify 5 app factory with injected DB + queue fakes (no live infra in tests).
Kysely + better-sqlite3 locally (dialect factory ready for Postgres). Queue is a seam:
in-process executor in dev (`QUEUE_DRIVER=local`), BullMQ in deployment (`QUEUE_DRIVER=bullmq`).
Engines spawn the typed `milo` CLI; deploy delegates to `@milo/publish`.

**Tech Stack:** Node 24 (TS via type-stripping, repo convention), Fastify 5, Kysely + better-sqlite3,
BullMQ + ioredis (prod only), Zod, React 19 + Vite 6 + TanStack Query + `@pushpress/pushpress-ui`
(Button/Badge/Input confirmed in sibling repos; GitHub Packages already in `~/.npmrc`), Vitest.

**Workspace/git rules:**
- Stay ON `page-clone-engine` (shared with the engine session; do NOT branch/switch — they'd break).
- Only ever add: `apps/admin/**`, `docs/superpowers/plans/2026-08-01-milo-admin-phase1.md`, root
  `package.json` script, `pnpm-lock.yaml` (install side-effect). Never `git add -A`.
- Commits wait on `.git/index.lock` (loop up to 60s) — the engine session commits concurrently.
- No deploys, no live engine runs, no network-dependent behavior in this session.

**Deliberate deviations from spec (v1, documented):**
- `fastify-zod-openapi` deferred: v1 validates with Zod `safeParse` in handlers via a small
  `parseBody/parseParams` helper. OpenAPI plugin wiring is a follow-up (its v5 surface wasn't
  verifiable offline; single integration point keeps the swap cheap).
- UI uses pushpress-ui `Button/Badge` at the leaf level with hand-rolled layout (only those
  exports are confirmed in sibling repos; broader adoption once the package surface is verified).

## File structure

```
apps/admin/
  package.json  tsconfig.json  vitest.config.ts  vite.config.ts
  src/
    config.ts                 # zod env: PORT, DB_PATH, REDIS_URL, QUEUE_DRIVER, AUTH_MODE, DATA_DIR, GOOGLE_CLIENT_ID
    server/
      index.ts                # SERVICE=api|worker|monolith entry
      app.ts                  # buildApp({config, db, queue, jobRunner, now}) → Fastify instance
      routes/health.ts        # GET /healthz
      routes/workspaces.ts    # GET/POST /api/v1/workspaces, GET /:id
      routes/companies.ts     # GET/POST /api/v1/companies, GET /:id
      routes/sites.ts         # GET/POST /api/v1/sites, GET /:id, POST /:id/jobs, GET /:id/jobs
      routes/jobLogs.ts       # GET /api/v1/jobs/:id/logs (JSON snapshot; SSE follow-up)
    db/
      types.ts                # Database interface: workspaces, companies, sites, jobs, deploys, job_logs
      index.ts                # createDb(config) → Kysely (SqliteDialect), migrateToLatest
      migrations.ts           # migration1: all tables
    auth/plugin.ts            # onRequest hook; dev mode (all-pass, actor=dev@pushpress.com), google mode (JWT cookie; verifier interface)
    jobs/
      dispatch.ts             # enqueueJob + per-site promote lock (pure, unit-tested)
      queue.ts                # EngineQueue interface; localQueue (in-process), bullmqQueue
      runner.ts               # runCli command table (seed/generate/build via milo CLI), log sink → job_logs
      deploy.ts               # staging/promote/rollback via @milo/publish
  web/
    index.html  src/main.tsx  src/App.tsx  src/api.ts  src/components/*.tsx
  test/
    health.test.ts  db.test.ts  registry.test.ts  dispatch.test.ts  sites.test.ts
```

## Tasks

1. **Scaffold** — `apps/admin/package.json` (@milo/admin), tsconfig extends base, vitest config
   (`fileParallelism: false`), `pnpm install`. Root script: `"dev:admin": "pnpm --filter @milo/admin dev"`.
2. **Config + app factory + health** — `src/config.ts` zod env; `buildApp` takes injected deps;
   `GET /healthz` → `{ok:true}`. Tests: boot in dev mode, hit /healthz. Run red→green→commit.
3. **DB** — `db/types.ts`, sqlite dialect (`DB_PATH`, `:memory:` in tests), migrations for the six
   tables (text ISO timestamps, `status` text enums, `active` int 0/1), `migrateToLatest` on boot.
   Test: migrate fresh DB, insert+select roundtrip per table.
4. **Auth plugin** — `AUTH_MODE=dev` all-pass with actor; `google` mode reserved (verifier interface,
   wiring follow-up — v1 ships dev). Test: dev mode injects actor on request context.
5. **Registry routes** — zod-schematized bodies; validation failure → 400 with `issue.message`
   (sentence-case, per content guidelines). Tests: create/list/get incl. 400 + 404 paths.
6. **Dispatch (per-site lock)** — jobs.status: waiting|queued|running|succeeded|failed.
   `enqueueJob` inserts waiting; `promote(siteId)` starts oldest waiting iff none active for site;
   `finish/failJob` → promote. Queue position = count of earlier waiting for that site.
   Tests: 3 jobs same site serialize; different sites parallel; position math; failure promotes next.
7. **Sites + jobs routes** — POST /sites validates seedType; template seed requires
   `name/city/state/sourceUrl` (milo intake contract); POST /:id/jobs type in
   seed|build|deploy-staging|promote|rollback → enqueueJob → 202 {jobId, queuePosition};
   GET /:id/jobs lists with positions. Tests with fake queue.
8. **Runner + queues** — `runCli(args, log)` spawns `node ../../cli/src/milo.ts <args>` (cwd =
   repo root), streams stdout/stderr lines to `job_logs` (+console). Command table:
   seed: intake --url … --name --city --state --out <dataDir>/sites/<siteId>/seed
   build: generate --docs <seedDir> → build --gym <seed>/gym.json --theme <payload.templateId> --out <dist>
   deploy-staging|promote|rollback → deploy.ts via @milo/publish resolveOrInitConfig +
   createRealS3/KvsAdapter (config from publish.json next to gym.json).
   `localQueue` runs runJob inline async; `bullmqQueue` wraps BullMQ (imported lazily in worker mode).
   Tests: runner against a stubbed spawn; deploy mapping unit-tested with fake adapters.
9. **Web UI** — vite (root `web/`, build → `web/dist`), React + QueryClientProvider; three-pane
   shell: Workspaces → Companies → Sites; site detail card: status Badge, seed info, job history,
   trigger Buttons, latest job log (poll GET /jobs/:id/logs every 2s while active).
   `@fastify/static` serves `web/dist` at `/`; SPA fallback to index.html.
   Verify: `pnpm build:web`, assets exist; server serves `/` 200 + html.
10. **Verify** — `pnpm --filter @milo/admin test` green; boot monolith; curl roundtrip:
    workspace→company→site→trigger (job fails fast without engine env — expected; status/log path
    proven); commit each slice; root README + memory updates.

## Exit criteria

- `apps/admin` boots on `pnpm dev:admin` with zero external infra; dashboard browsable at :4100.
- Full registry CRUD + job trigger/queue/lock + logs visible in UI.
- Tests green; no changes outside allowed paths; all commits on page-clone-engine.
