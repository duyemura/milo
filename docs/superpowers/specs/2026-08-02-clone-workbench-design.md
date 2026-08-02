# Clone Workbench — the live demo loop, built on `apps/admin` (v1)

**Date:** 2026-08-02
**Status:** Design — approved in brainstorming, pending written-spec review
**Owner:** page/code-builder session; **this session becomes sole owner of `apps/admin`** (the admin session stands down on it), working in an isolated git worktree off `page-clone-engine`.
**Engine:** `@milo/clone-engine` (`packages/clone-engine`) — gains the four seams
**App:** `@milo/admin` (`apps/admin`) — surface rebuilt around the workbench; infra spine kept
**Depends on:** `buildSiteAuto()` (`src/orchestrate.ts`), the `edit` ops (subsystem C, `src/edit/*`), admin's `src/db` + `src/auth` + `src/jobs` + `src/server`
**Reuses:** admin's WorkOS auth, node:sqlite→Postgres DB (`sites`/`jobs`/`job_logs`), `EngineQueue` (per-site lock + queue positions), Fastify boot, Railway hosting decision
**Doctrine:** `packages/clone-engine/DOCTRINE.md`; never-regress: `feedback_never_regress_html_eval`
**Related:** `2026-08-01-milo-admin-design.md` (admin), `2026-08-02-clone-qa-report-design.md` (QA — surfaced via the report seam, built separately), `project_milo_unified_vision`

## Purpose

Build the thinnest end-to-end thing that **actually works and can be watched**: paste a URL → see it clone **live** (page 4/18 → 4/19 as links are discovered) → see the built site → see the build report → make edits by chat → see them apply on the served site → see the logs. Today the engine is proven but **invisible** — progress is `console.log` only, there is no live surface, and the operator (Dan) is trusting subagent reports blind. This gives the engine eyes.

The realization that shapes the whole design: this "demo" is **not a standalone throwaway app.** It is `apps/admin`'s real chat + live-preview workbench (admin's own phase-2 vision — its Preview tab is already described as "the shell for the future AI-editor layout: chat rail + live site"). Admin already has WorkOS auth, a Railway hosting decision, the `sites`/`jobs`/`job_logs` DB, clone-seed wiring, and a queue. So we build **on** admin, reuse that infra, and the only genuinely new work is four durable engine seams plus a rebuilt surface. The durable parts land in the engine (admin consumes them); only the UI shell is disposable.

## Key decisions (brainstormed 2026-08-02 — do not re-litigate)

1. **Build on `apps/admin`, not a standalone `apps/demo`.** Reuse admin's auth/DB/queue/Railway. This session owns `apps/admin` solely; work happens in an isolated worktree so it never collides with any other session.
2. **The report is decoupled from the workbench.** The workbench *surfaces* whatever report a build emits (`build-report.json` + report HTML). Today that is `report.ts`; when the QA Inspector (`src/qa/`) lands it slots into the same seam with zero workbench rework. QA is a separate project; the workbench does not block on it.
3. **Live-real runs, live state — never a replay.** A build shows live progress while running; a finished build simply reads "completed" with its artifacts. State is reconstructed from persisted events, not animated from a recording.
4. **Editing is a chat workbench, not "one edit."** Chat on the left, the live site on the right; the operator makes any and all edits ("edit the hero to X", "change the primary brand color to green"). Every message runs the real subsystem-C pipeline (`plan → apply → verify → self-correct → revert`) → rebuild → the preview reloads.
5. **Chat speaks plain English; engine internals live in the Logs tab.** Chat: "Done — your brand color is now green." Logs: plan/apply/verify, 0-px checks, timings, self-corrections. One event stream, two renderings.
6. **Seed-generic site model (two seeds, one substrate).** A site is seeded by `clone | template | none`. "Add a site" ≠ "clone." Endpoints are parameterized by `seedType`; **only the `clone` path is built now**, template is designed-for (modeled, not built).
7. **Surgical teardown of admin, not scorched earth.** Keep the proven infra spine (DB, auth, queue, server boot); rebuild the whole surface (React front-end, chat spike, keyword/measure side-jobs).
8. **sqlite local / Postgres on deploy, for now.** Guarded by the `PG_TEST_URL` cross-dialect parity test run before deploy. **Future:** Postgres everywhere (local Docker).
9. **Access = WorkOS** (already built, `@pushpress.com`-gated, Railway-ready). No separate `DEMO_PASSWORD` gate.
10. **Shared gallery.** Runs are global server-side state behind WorkOS — everyone sees every built site and can open/inspect/edit it. Builds run through a **one-at-a-time queue** (already built); editing an already-built site is cheap and does not queue behind builds.

## The two phases

**Clone.** Paste URL → the clone seed job runs `buildSiteAuto` (auto-discover → staged core/UGC build) → live progress (discovery count growing, per-page capture→project→build ticking) → assembled `full-site/` + `build-report.json` + report HTML.

**Edit.** The chat + live-preview workbench over the built site. Each chat message → subsystem C → rebuild affected page(s) → preview reloads. Report and Logs are tabs on the right pane.

## The four engine seams (durable, land in `@milo/clone-engine`)

All **additive and optional** — the engine behaves identically when no listener is attached, so the 0-px projection oracle and existing behavior never regress.

**① Progress events + `RunState`.** Add an optional `onEvent?: (e: EngineEvent) => void` to `BuildSiteAutoOpts` / `BuildSiteOpts` and the `edit` op options. The `console.log` sites in `orchestrate.ts` become typed events (console output is retained for CLI use). `EngineEvent` is a small discriminated union:

- Clone: `run.started`, `discover.progress {coreFound, ugcFound, routes[]}` (fires repeatedly — the total grows live), `page.capture|project|build.{started,done} {route}`, `page.failed {route, error}`, `assemble.done {pages, fullSiteDir}`, `report.done {reportJsonPath, reportHtmlPath}`, `run.completed {ok, failed}`.
- Edit: `edit.started {message}`, `edit.plan {opsSummary}`, `edit.apply`, `edit.verify {ok, correctionAttempt}`, `edit.rebuilt {route, ms}`, `edit.done {friendly}`, `edit.failed {reason}`.

The server keeps a live **`RunState`** rollup updated on every event so a browser connecting mid-run (or reopening a finished run) gets the picture instantly without event-replay logic in the client:

```ts
type Phase = "capture" | "project" | "build";
interface RunState {
  status: "discovering" | "building" | "built" | "failed";
  totalPages: number;
  pagesCompleted: number;
  current: { route: string; phase: Phase } | null; // e.g. "building /pricing"
  discovered: string[];                              // routes found so far
  failures: { route: string; error: string }[];
}
```

`RunState` is a **pure projection of the event log** (see data flow) — reconstructable by replaying a site's `job_logs`.

**② Local staging serve → admin's existing Preview.** No S3, no `deploy.ts`. Admin static-serves a site's built `full-site/` at `GET /sites/:id/site/*`; the workbench preview iframe points there. Reuses admin's existing preview plumbing.

**③ Edit-apply-redeploy.** A chat message → `POST /api/v1/sites/:id/edits {message}` → subsystem C (`plan→apply→verify→self-correct→revert`) → rebuild the affected page(s) into `full-site/` → `edit.rebuilt` event → the iframe reloads. Reuses C wholesale; the only new glue is "after a verified apply, rebuild that page and signal the UI."

**④ Structured logs = the event stream in `job_logs`.** The same `EngineEvent`s are persisted to admin's existing `job_logs` table. The Logs tab renders them raw; chat shows only the friendly derived text. No new store.

**CLI bridge (honors admin decision #3 "shell to executables, never import").** The runner keeps spawning the CLI for isolation (a Chromium OOM must not crash the server on a single Railway box). Seam ① also powers a **`--emit-events` JSON-lines mode** on the CLI; the runner reads those lines → `EngineEvent` → `job_logs` + live SSE. The CLI gains a `clone` / `build-auto` subcommand that runs `buildSiteAuto` with `--emit-events` (needed for the live discovery count). Admin stays shelled-out *and* gets structured events instead of scraped console text.

## What we keep vs. rebuild in `apps/admin`

**KEEP (proven, load-bearing):**
- `src/db/` — node:sqlite→Postgres; `sites` (`seedType`, `sourceUrl`) / `jobs` / `job_logs`. The persistence.
- `src/auth/` — WorkOS, `@pushpress.com`-gated, Railway-ready.
- `src/jobs/queue.ts` + `runner.ts` + `dispatch.ts` + `deploy.ts` — build queue, per-site lock, engine spawn.
- `src/server/` boot + `config.ts` — Fastify setup, env config, `$PORT`.

**TEAR DOWN + rebuild:**
- **`web/` — the entire React front-end** (3-pane dashboard, UI-v2 shell, sidebar/topbar, `/chat` spike). Rebuild as: **paste URL → live clone progress → chat+preview workbench** with Report/Logs tabs and a desktop/mobile toggle.
- **`src/chat/` (router/actions/todos)** — the general intent-router spike. Replace with the one focused path: `POST /sites/:id/edits` → subsystem C. No intent-router, no todos.
- **`src/jobs/keywordCycle.ts` + `measure.ts`** — keyword-brain/measurement side-experiments, out of scope. Remove; drop the now-unused `@milo/keyword-brain` / `@milo/measurement` deps.
- **Prune `server` routes** to the focused set below.

## Seed-generic site model + routes

`seedType ∈ 'clone' | 'template' | 'none'`. Creation is decoupled from seeding; the common path auto-triggers.

- **`POST /api/v1/sites { seedType, sourceUrl? }`** — create the site record; if a valid seed is specified, auto-enqueue the seed job. The workbench "paste URL" path = `{ seedType: 'clone', sourceUrl }` → creates + clones in one call.
- **`POST /api/v1/sites/:id/seed { seedType, sourceUrl? }`** — (re)seed: seed an empty shell, switch `none`/`template` → `clone`, or re-clone after a bad run.
- **`GET /api/v1/sites`** — the shared gallery.
- **`GET /api/v1/sites/:id`** — detail + current `RunState`.
- **`GET /api/v1/sites/:id/events`** (SSE) — `RunState` snapshot first, then live `EngineEvent` deltas.
- **`POST /api/v1/sites/:id/edits { message }`** — subsystem-C edit → rebuild; events flow on the same SSE.
- **`GET /sites/:id/site/*`** — static-serve the built `full-site/` for the preview iframe.
- **`GET /api/v1/sites/:id/report`** — `build-report.json` (+ report HTML). Logs come from `job_logs`.

Only the **clone** seed path is built in v1; the endpoints are seed-generic so template slots in later with no redesign.

## Data flow — `job_logs` is truth, `RunState` is a projection

Clone:
1. `POST /sites` → insert site (`seedType='clone'`) → enqueue via `EngineQueue` (per-site lock, queue position).
2. Runner spawns the CLI `clone --emit-events` → reads JSON-lines `EngineEvent`s → for each: **append to `job_logs`** + update in-memory `RunState` for that site + push to live SSE subscribers.
3. `assemble.done` / `report.done` / `run.completed` → mark job/site status; store `full-site/` + report paths.
4. Browser opens `/sites/:id` → subscribes to SSE → gets the `RunState` snapshot instantly (even for a finished run — reconstructed by replaying that site's `job_logs`) → renders progress live → flips to the workbench on completion.

Edit: same pipe. `POST /edits` → runner spawns CLI `edit --emit-events` → C's `edit.plan/apply/verify/rebuilt/done` → `job_logs` + SSE → on `edit.rebuilt` the iframe reloads; chat shows the friendly `edit.done`, Logs shows raw events.

Property: a server restart or a late-joining browser both reconstruct state the same way — **replay `job_logs` → `RunState`** — so there is no separate cache to keep coherent, matching admin's existing "state is a projection" philosophy.

## UI — the workbench

- **Home / Paste:** URL box + the shared gallery (each run: `building` / `✅ built` / `failed`).
- **Clone progress:** live — discovery count growing ("12 core, 4 UGC — page 6/16"), per-page capture→project→build, failures surfaced. Reopening a finished run reads "completed" with artifacts.
- **Workbench:** chat left / live-preview iframe right; **Report** and **Logs** tabs on the right pane; desktop/mobile toggle. Chat = plain English; Logs = raw events. Built with `@pushpress/pushpress-ui` per house style; UI copy in **sentence case**.

## Deploy

- **Local:** `pnpm dev` — sqlite, WorkOS dev-mode (all-pass), local in-process queue. Zero setup.
- **Railway:** `Dockerfile` on Playwright's base image (the spawned CLI needs Chromium + system deps). Binds `$PORT`. **Postgres plugin → `DATABASE_URL`** (records durable — gallery survives redeploys). **Redis plugin → `QUEUE_DRIVER=bullmq`** (built + smoke-tested). WorkOS env for auth. A **Railway volume for the built-artifacts dir** so previews survive redeploys (without it, the gallery lists but previews 404 until a one-click rebuild).

## Testing

- **Unit (TDD where cheap):** the `onEvent` seam emits the correct events for a fixture build; the CLI `--emit-events` JSON-lines format; and the **pure `job_logs` → `RunState` projection** (tested hard — the keystone).
- **Integration:** the focused routes (create+seed, SSE snapshot, edit) against a small fixture with the engine stubbed.
- **Parity guardrail:** the `PG_TEST_URL` cross-dialect test stays green and **runs before deploy.**
- **Never-regress:** the engine seam is additive/optional → the 0-px oracle + existing engine tests stay green.
- **Acceptance (the real one):** watch a real clone run on a live URL, then make chat edits and see them apply. That is the milestone.

## Out of scope (YAGNI, v1)

- **Template seed path** — modeled, not built.
- **QA Inspector** (`src/qa/`) — surfaced via the report seam whenever it lands; workbench shows the current report until then.
- **Live S3/CloudFront production publish** — the old `deploy.ts` path stays human-authorized; the workbench previews locally, never pushes to mygymseo.com.
- **Per-user isolation** — shared gallery behind WorkOS is fine.
- **Postgres-everywhere local** — future; sqlite-local holds for now behind the parity test.
- **E-v2 (section-harvest)** — separate worktree/terminal, `packages/clone-engine/src/harvest/` only.

## Risks

- **Two sessions, one repo.** The E-v2 terminal and this session must not collide. Mitigation: separate worktrees + branches; E-v2 stays in `src/harvest/`, this session owns `apps/admin/*` + the engine seam files (`orchestrate.ts`, a new events module, `cli.ts`). Different files → clean merges. Neither self-merges; Dan integrates.
- **Teardown regressions.** Ripping out `web/` + `src/chat/` + side-jobs could break kept infra (server boot, routes, tests). Mitigation: keep admin's kept-module tests green after each removal; the DB/auth/queue modules are untouched.
- **CLI event-parsing brittleness.** JSON-lines on stdout must be robust to interleaved engine output. Mitigation: emit events on a dedicated marker/stream and `stripControl()` (admin already learned ANSI/control chars break strict JSON parse); ignore non-event lines.
- **Live-progress fidelity.** `buildSiteAuto`'s discovery must actually emit incremental `discover.progress` for the count to grow; if discovery is a single batch, the "4/18 → 4/19" effect degrades to one jump. Mitigation: emit `discover.progress` as routes are found, not only at the end.
- **Railway resources.** Chromium + Astro builds are memory-hungry; a ≥2GB instance and the one-at-a-time build queue keep a shared box stable. Editing does not queue behind builds.
- **sqlite/PG drift.** Guarded by Kysely + the proven parity test; the discipline is running that test before deploy.

## Self-review

- **Placeholders:** none. Every seam names concrete existing machinery (`buildSiteAuto`, `edit/*`, `orchestrate.ts` log sites, `cli.ts`, admin `src/db`/`src/auth`/`src/jobs`/`src/server`, `job_logs`, `EngineQueue`).
- **Consistency with decisions:** matches the 10 brainstormed decisions and `project_milo_unified_vision` (two seeds/one substrate; clone is the seed, not the deliverable; industry-neutral core — nothing here hardcodes "gym"; the engine seam only labels/observes, never generates layout).
- **Scope:** additive to the engine (optional `onEvent`, a CLI event mode, a `clone` subcommand); a surface rebuild + surgical teardown in admin; the DB/auth/queue spine untouched. QA and template seed are explicitly deferred to their own seams/projects.
- **Ambiguity flagged:** the honestly-uncertain calls are (a) whether `buildSiteAuto` discovery can emit incremental progress (risk noted), and (b) CLI event-stream robustness (risk noted, mitigation = dedicated marker + `stripControl`). Both fail toward degraded progress, not broken builds.
