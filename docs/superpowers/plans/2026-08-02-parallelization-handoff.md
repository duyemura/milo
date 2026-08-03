# Clone Parallelization — Handoff / Review Request

**For the reviewing session:** the per-page website-clone build was parallelized this session. It's implemented, tested, self-reviewed, and the review findings are fixed. This doc is a request for a second pair of eyes to confirm it's solid before it lands anywhere permanent. Branch: `admin-workbench` (main checkout, base `main`).

---

## What shipped (7 commits on top of `a8b2422`)

The serial per-page build loop in `@milo/clone-engine` is now a **bounded, host-sized concurrency pool**. Output is intended to be **byte-identical** to the old serial path.

| Commit | Change |
|---|---|
| `009506e` | `concurrency.ts`: `mapPool` (bounded async map) + `autoConcurrency` (cgroup-aware sizing) |
| `107e05e` | astro build `execSync`→async `spawn` (so pooled builds actually overlap); pin `@types/node@^24` |
| `3b19be9` | `buildSite` loop → `mapPool(augmented, concurrency, buildOnePage)`; run-level LLM cost aggregate |
| `9103667` | `--concurrency` CLI flag on `build-auto`/`build-site` |
| `9edf001` | **review fixes** — per-build Vite cache isolation + non-finite concurrency guard |
| `699884c` | plan docs (live + 3 deferred cloud-scale plans) |
| `c5d03f5` | remove ported `.mjs` prototypes |

**Files:** `packages/clone-engine/src/{concurrency.ts (new), orchestrate.ts, project.ts, report.ts, cli.ts, package.json}` + `test/concurrency.test.ts`.

## Verification already done

- **Full engine suite green:** 324 passed / 3 skipped, incl. `parity-capture.test.ts` + `parity-project.test.ts` (the byte-identical gates).
- **Live smoke:** crossfitnewengland.com, 16 pages, ~70–90 s wall at `concurrency=16` (vs ~11 min serial ≈ **~7×**), 16/16 assembled, `index.html` self-contained (0 leftover source-origin refs).
- **Self-review (code-reviewer agent)** found 2 real issues, both fixed + verified:
  1. Concurrent builds shared Vite's `node_modules/.vite` dep-cache through the symlink → race. Fixed: `project.ts` emits `vite.cacheDir=".vite"` (per-project). Verified: shared `.vite` no longer created; 16 per-page `.vite` dirs.
  2. `--concurrency abc` → `NaN` → 0 workers → crash. Fixed: `mapPool` floors non-finite/zero to 1 (test added); CLI rejects with a clear message.

## What to double-check (the review ask)

1. **Byte-identical output on a *different* site than CFNE** — the parity tests exercise `capture()`/`project()` directly, NOT the concurrent `buildSite` path. Suggest: build one site at `--concurrency 1` and again at `--concurrency 8`, diff `full-site/` — should be identical. (Torrance or Speakeasy are good, non-trivial.)
2. **Concurrency safety** — confirm no cross-page shared mutable state beyond what's handled: `links-site.json` (write-once-before-pool), per-page `p.out/astro` dirs + their own node_modules symlink, `capture()` cleaning only its own `assets/`, and the now-per-project Vite cache. `buildOnePage` must never throw (try/catch wraps the whole body → returns `status:"failed"`).
3. **Railway/container sizing** — `autoConcurrency()` reads cgroup `cpu.max`/`memory.max`. Sanity-check the formula on a real container (a 2-vCPU/1 GB box should yield a small K, not 16). Env override: `CLONE_CONCURRENCY`.
4. **Admin path** — admin spawns the CLI (`apps/admin/src/jobs/runner.ts`), so it inherits the speedup with no change. Confirm the interleaved `page.*` progress events (now out of order under the pool) don't confuse the admin RunState reducer (events are keyed by `route`, so should be fine — but verify the "current page" UI degrades gracefully).

## How to run

```bash
# default: host-sized concurrency
node packages/clone-engine/src/cli.ts build-auto --site <origin> --out /tmp/r.html
# pin it
node packages/clone-engine/src/cli.ts build-auto --site <origin> --concurrency 8 --out /tmp/r.html
# tests
cd packages/clone-engine && pnpm test
```

## Open follow-ups (NOT done — decisions/tasks remaining)

- **Engine should own its Astro dep.** Today `orchestrate.ts:220` symlinks `page-clone-spike/out-project-page/astro/node_modules` (Astro 4.16) as the build's node_modules. `project.ts`'s `out-project-page` ref is only a default string (not a real dep). Proper fix: add `astro@^4.16` to `@milo/clone-engine`, repoint `orchestrate.ts`, delete `out-project-page/` (151 MB, now trimmed to just the astro install). **Needs a build-verify** — pnpm's non-flat `node_modules` resolves astro's transitive deps differently than this flat npm install. `apps/renderer` has Astro **v5** (incompatible — the engine emits v4.16 projects), so it can't be reused.
- **Cloud horizontal scale** — 3 deferred plans exist (`artifact-store-seam-minio`, `parallel-phase-split-pipeline`, `distributed-capture-queue`) for multi-replica scale (wall time flat in page count). Not needed for single-instance; the current in-process pool is forward-compatible with them.
- **Branch decision** — these commits sit on `admin-workbench` alongside unrelated committed admin work. Not yet merged/PR'd. Options: keep as-is, or cherry-pick the 6 engine commits onto a clean branch off `main` and PR just those (they're engine-only, cherry-pick cleanly).

## Cleanup done this session (context)

Reclaimed ~5.2 GB of regenerable spike artifacts from `page-clone-spike/` (harvest corpus, ks/to/torr capture output, report artifacts, dead prototypes). Kept: `fidelity-oracle.ts`, `eval-edit.ts` (+ edit-subsystem source), and `out-project-page/astro/node_modules` (the build dep). `git status` is clean apart from pre-existing unrelated modified files.
