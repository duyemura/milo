# Milo Docs Storage Plumbing Design (Chunk A)

**Date:** 2026-08-03
**Status:** Approved — ready for implementation plan
**Scope:** `@milo/storage` shared package, `runLearn` doc writing through the storage seam, `--verbose`/logger seam, `milo clone --deploy`
**Parent spec:** `2026-08-03-milo-cli-pipeline-design.md` (Docs Storage Structure section — implemented here; supersedes its local layout, see below)
**Deferred:** Chunk B (docs→clone consumption: pages.json discovery seeding, labeler context, brand cross-check, asset alternatives) — separate spec after this ships.

---

## Context

`milo learn` writes intelligence docs (`context.md`, `business.md`, `brand.json`, `pages.json`, crawl bundle, assets) with plain `node:fs/promises` into `--out <dir>`. It has no knowledge of S3/MinIO. The `StorageAdapter` seam exists but is private to `packages/clone-engine/src/storage/` and only wired to the capture cache. The parent spec's "Docs Storage Structure" section was never implemented.

Decisions locked during design review:

1. Promote the storage seam to a shared `@milo/storage` package (not intake→clone-engine import, not duplication).
2. **Full cutover** for clone-relevant paths — no dual-write legacy path.
3. The `generate`/template path is **deprecated** (clone covers both DOM-clone and `--template` strategies). It is out of scope and must keep working via `--out` override only; no storage-read cutover for it.
4. `--verbose` is in scope for `learn`, implemented as a logger seam, not scattered `console.log`.
5. `milo clone --deploy` is opt-in (never auto-deploy); staging is always real S3/CloudFront — no MinIO site-serving work.
6. Clone focus only — clone-engine internals are untouched except the two ENOENT papercuts (separate task).

---

## Section 1 — `@milo/storage` package

New package `packages/storage` (`@milo/storage`), moved from `packages/clone-engine/src/storage/`:

- `adapter.ts` (`StorageAdapter` interface: `get`/`put`/`exists`/`delete`), `local.ts` (`LocalFsAdapter`), `s3.ts` (`S3Adapter`), and the `getStorage()` factory move as-is.
- Clone-engine's `capture-cache.ts` stays in the engine but imports the adapter from `@milo/storage`. The engine's `storage/` directory is deleted; engine imports updated.
- Backend selection stays env-driven:
  - `STORAGE_BUCKET` set → `S3Adapter` (`STORAGE_ENDPOINT` for MinIO, `STORAGE_KEY`/`STORAGE_SECRET`/`STORAGE_REGION`).
  - unset → `LocalFsAdapter`.
- **Local root changes:** `MILO_STORAGE_DIR` ?? `CAPTURE_CACHE_DIR` (deprecated alias, still honored) ?? `~/.milo`. Today the default is `os.tmpdir()/milo-storage` — the tmpdir capture cache is abandoned on switchover; it's a cache, it rebuilds.
- New util in this package: `slugFromUrl(url)` — hostname, lowercase, strip leading `www.`, dots→dashes (`speakeasyofstrength.com` → `speakeasyofstrength-com`). Both learn (write) and later clone (read) need identical derivation, so it lives here.

## Section 2 — learn writes through the seam

`runLearn` options gain:

- `storage?: StorageAdapter` — defaults to `getStorage()`.
- `slug?: string` — defaults to `slugFromUrl(opts.url)`.

Every current `writeJson`/`writeFile` call routes through the adapter at keys:

```
gyms/<slug>/docs/
  context.md  business.md                          ← narrative (per parent spec)
  brand.json  pages.json                           ← canonical top-level copies (per parent spec)
  context.json  business.json  integrations.json   ← structured (template-path compat until deprecation)
  crawl/      ← identity.json, links.json, gmb-assets.json, pages/<page-slug>.json (intermediates)
              ← plus deprecated duplicate copies of brand.json + pages.json
  assets/     ← GMB + page images (binary put)
```

`brand.json` and `pages.json` are written at **both** top level (canonical, for Phase 2 readers) and `crawl/` (deprecated duplicate). Reason: the still-live `generate` path reads `crawl/brand.json` and `crawl/pages.json` (`apps/cli/src/generate.ts:22-23`) and must keep working until removed. The `crawl/` copies are deleted when the generate path is removed.

- `--out <dir>` stays as an explicit override: it constructs a `LocalFsAdapter` rooted at `<dir>` with no key prefix, so docs land exactly in `<dir>` — today's byte-for-byte locations. This keeps the deprecated template flow (`learn --out seedDir → generate --docs seedDir`) working untouched until it's removed.
- Asset downloads (GMB photos, page images) write binary through the same adapter (`put` takes `Buffer`).
- **Deviation from parent spec:** local layout becomes `~/.milo/gyms/<slug>/docs/` (not `~/.milo/docs/<slug>/`) — identical keys locally and in S3, one code path. Parent spec text updated accordingly.
- `runIntake` (deprecated wrapper) inherits this — it calls `runLearn`, so its docs move too. Its `gym.json` write also routes through the same adapter for consistency.

## Section 3 — logger seam + `--verbose`

- `runLearn` gains `logger?: MiloLogger` where `interface MiloLogger { info(msg: string): void; verbose(msg: string): void; warn(msg: string): void }`. Default: console-backed, verbose suppressed. No bare `console.log`/`console.warn` remains in intake.
- `--verbose` on `milo learn` enables per-event detail: each page crawl (URL, status, ms), each LLM call (kind, model, duration), each asset download. Default output stays the current milestone lines.
- The logger is a seam: when the admin later moves from subprocess to direct function calls (parent spec item 4), it passes a structured emitter and gets every event — no stdout scraping. Until then, admin can pass `--verbose` through to the CLI to enrich its existing log view.
- `milo clone` already streams the engine's chatty output via stdio inherit — no flag there. `verbose` is added to `LearnJob` in `@milo/schema` only. No no-op flags.

## Section 4 — CLI changes

- `milo learn`: `--verbose` flag; on completion prints the resolved docs location (local path or `s3://bucket/gyms/<slug>/docs/`).
- `milo clone <url> --deploy`: after a successful build, runs the existing staging publish (`publishStaging` from `@milo/publish`, same as `milo publish staging`) against the built `full-site/`.
  - `CloneJob` schema gains `deploy: z.boolean().default(false)`.
  - **Fail fast:** `--deploy` validates publish config (AWS bucket/creds resolvable) *before* the build starts — no 5-minute build then a config error.
  - Staging is always real S3/CloudFront. Locally without AWS config, `--deploy` errors clearly and preview stays `npx serve <out>/full-site`.

## Section 5 — error handling

- **Backend visibility:** learn logs which storage backend it resolved at startup (`[learn] storage: local (~/.milo)` vs `[learn] storage: s3://bucket`). No silent fallback ambiguity.
- **S3/MinIO write failures propagate** — a failed doc write fails the learn run loudly. No partial "succeeded but half the docs are missing" state.
- **`--deploy` without publish config** → clear pre-build error.
- Engine ENOENT papercuts (`links-site.json` write without mkdir; `ex-home/assets` scandir on asset-less pages) are a separate small task, not part of this plan.

## Section 6 — testing

- **`@milo/storage`:** existing adapter tests move with the code; add factory tests for env selection (bucket set/unset, MinIO endpoint, `MILO_STORAGE_DIR` override) and `slugFromUrl` cases.
- **intake:** `runLearn` tests inject a `LocalFsAdapter` rooted at a tmp dir and assert keys land at `gyms/<slug>/docs/...` including binary assets. Logger events asserted via a fake logger (verbose events only when enabled). Existing `runIntake` wrapper test stays green.
- **CLI:** smoke tests as before (bad URL, usage). `--deploy` flag plumbing covered by a unit test on arg→job mapping; actual publish stays a manual smoke (needs AWS).
- **No-regress rule:** after implementation, re-run a real clone (speakeasyofstrength.com) and confirm pages still build — HTML output unchanged by this work.

---

## Migration order

1. Create `@milo/storage`, move seam + tests, add `slugFromUrl`, repoint clone-engine imports.
2. `LearnJob.verbose` + `CloneJob.deploy` in `@milo/schema`.
3. `runLearn`: logger seam, storage-backed doc writing, key layout per Section 2.
4. CLI: `learn --verbose`, docs-location output, `clone --deploy` with pre-build publish-config check.
5. Update parent spec text (local layout) and mark its Docs Storage Structure section implemented.
