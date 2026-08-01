# Milo admin

Internal control plane for client websites: registry of clients/gyms/sites, engine job
runner (seed → build → deploy → promote → rollback) with per-site serialization, a
chat-first admin page with suggested actions, and a pipeline dashboard
(onboarding → building → in-review → live).

Design: `docs/superpowers/specs/2026-08-01-milo-admin-design.md`

## Run locally (zero setup)

```bash
pnpm dev:admin          # → http://127.0.0.1:4100 — dev auth (all-pass team), sqlite, in-process job queue
pnpm dev:admin:web      # optional: vite hot-reload UI on :4101 (proxies API to :4100)
pnpm build:admin:web    # build the dashboard (deploy/prod-style serving needs this)
pnpm --filter @milo/admin test
```

## Modes (all env-driven; see src/config.ts)

| Var | Local default | Production |
|---|---|---|
| `AUTH_MODE` | `dev` (all-pass) | `workos` — Google-only sign-in, `@pushpress.com` enforced |
| `DB_PATH` / `DATABASE_URL` | sqlite file | `postgres://…` |
| `QUEUE_DRIVER` / `REDIS_URL` | `local` (in-process) | `bullmq` + `redis://…` |
| `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` / `WORKOS_COOKIE_PASSWORD` / `WORKOS_REDIRECT_URI` | — | required in workos mode (repo-root `.env` supplies the first two) |

Env files: `apps/admin/.env` (admin overrides, gitignored) → repo-root `.env` (shared
milo values: WorkOS keys, `OPENROUTER_API_KEY`, `GOOGLE_PLACES_API_KEY`, AWS profile via
the engine's expectations). Chat assistant uses OpenRouter (`CHAT_MODEL`, default
`anthropic/claude-haiku-4.5`); without a key it falls back to deterministic commands
("launch X", "task: …").

## Engines this drives

Spawns **typed executables only** (never imports engine internals):

- **template seed** → `apps/cli/src/milo.ts` (intake → generate → build)
- **clone seed** → `packages/clone-engine/src/cli.ts` (capture → project → astro build)
- **deploy** → `@milo/publish` (template) or clone-engine `deploy` (clone seeds;
  live staging deploys are human-authorized)

## Notes for the next person

- Job logs are append-only (`job_logs`); seq is assigned app-side per job.
- Suggested tasks are **derived from live state** on every read — nothing persists,
  they vanish when the world changes.
- Production mutations (`promote`/`rollback`) are guarded in chat (explicit confirm)
  and gated on a live staging deploy.
- rtk truncates long `curl` output (~200 B, appends `...\n`) — verify endpoints with
  python/node clients, not curl.
