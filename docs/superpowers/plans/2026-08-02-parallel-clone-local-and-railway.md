# Parallel Clone — Local + Railway (Focused Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the per-page clone build concurrently instead of serially, sized automatically to the host — so it's ~6–8× faster locally and behaves correctly (no thrash/OOM) on any Railway instance size — with byte-identical output.

**Architecture:** Replace the serial `for` loop in `buildSite()` with a bounded async pool (`mapPool`) whose width comes from a container-aware `autoConcurrency()` (reads cgroup CPU/memory limits so it's right inside a Railway container). The per-page pipeline (capture → label → project → astro build) is unchanged per page; only the scheduling changes. The astro build switches from `execSync` (which blocks the event loop) to an async `spawn` so pooled builds truly overlap. No storage/queue/phase-split machinery.

**Tech Stack:** Node 24, TypeScript, Playwright, Astro. No new dependencies.

**Non-goals (explicitly deferred):** shared object storage (MinIO/S3), distributed BullMQ workers, multi-replica horizontal scale. Those live in the shelved plans `2026-08-02-artifact-store-seam-minio.md` (Plan 1) and `2026-08-02-distributed-capture-queue.md` (Plan 3) for if/when we want wall time flat in page count across replicas.

**Guardrail:** output must stay byte-identical. The existing `test/parity-capture.test.ts` / `test/parity-project.test.ts` and a fidelity eyeball are the gate — this changes scheduling, not clone logic.

---

## File Structure

- `packages/clone-engine/src/concurrency.ts` (**create**) — `mapPool()` (bounded async map) + `autoConcurrency()` (container-aware sizing).
- `packages/clone-engine/src/orchestrate.ts` (**modify**) — extract the loop body into `buildOnePage()`, drive it via `mapPool`, async astro build, aggregate LLM cost.
- `packages/clone-engine/src/report.ts` (**modify**) — add run-level `totalLlmCostUsd`/`totalLlmTokens` (per-page LLM cost can't be attributed race-free under concurrency).
- `packages/clone-engine/src/cli.ts` (**modify**) — `--concurrency N` flag on `build-auto`/`build-site`.
- `packages/clone-engine/test/concurrency.test.ts` (**create**) — pool + sizing unit tests.

---

## Task 1: `mapPool` + container-aware `autoConcurrency`

**Files:**
- Create: `packages/clone-engine/src/concurrency.ts`
- Test: `packages/clone-engine/test/concurrency.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mapPool, autoConcurrency } from "../src/concurrency.ts";

describe("mapPool", () => {
  it("preserves input order in results", async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0, peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
  it("runs with width 1 for an empty list without hanging", async () => {
    expect(await mapPool([], 4, async (x) => x)).toEqual([]);
  });
});

describe("autoConcurrency", () => {
  it("honors an explicit CLONE_CONCURRENCY override", () => {
    expect(autoConcurrency({ env: { CLONE_CONCURRENCY: "7" } })).toBe(7);
  });
  it("ignores a non-numeric/zero override and falls back to auto", () => {
    const k = autoConcurrency({ env: { CLONE_CONCURRENCY: "0" }, hardCap: 8 });
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(8);
  });
  it("clamps between 1 and the hard cap", () => {
    const k = autoConcurrency({ env: {}, hardCap: 8 });
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/concurrency.test.ts`
Expected: FAIL — cannot resolve `../src/concurrency.ts`.

- [ ] **Step 3: Write the implementation**

```ts
import os from "node:os";
import fs from "node:fs";

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations; results are
 * returned in input order. `fn` MUST NOT throw for per-item failures — model those
 * as a result value — because a throw rejects the whole pool.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length || 1));
  const workers = Array.from({ length: width }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** vCPUs available to THIS process. Reads the cgroup v2 quota so it is correct
 *  inside a container (os.availableParallelism reports the HOST core count, which
 *  over-reports on Railway/EC2 and would cause thrash). */
function effectiveCpus(): number {
  try {
    const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota !== "max") {
      const q = Number(quota), p = Number(period || "100000");
      if (q > 0 && p > 0) return Math.max(1, Math.floor(q / p));
    }
  } catch { /* not a cgroup-v2 container */ }
  return os.availableParallelism?.() ?? os.cpus().length;
}

/** Memory limit (MB) for THIS process — cgroup v2 first, else host total. Caps
 *  concurrency so K headless browsers can't OOM a small Railway instance. */
function memLimitMB(): number {
  try {
    const v = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (v !== "max") return Math.floor(Number(v) / 1048576);
  } catch { /* */ }
  return Math.floor(os.totalmem() / 1048576);
}

export interface AutoConcurrencyOpts {
  env?: Record<string, string | undefined>;
  /** Estimated RAM per concurrent headless browser. Default 500 MB. */
  perBrowserMb?: number;
  /** cores × this = CPU-bound ceiling. >1 because capture is ~40% idle wait. Default 1.5. */
  coreFactor?: number;
  /** Absolute ceiling regardless of hardware. Default 16. */
  hardCap?: number;
}

/**
 * Concurrency sized to the host. `CLONE_CONCURRENCY` (positive int) overrides
 * everything. Otherwise min(cores×coreFactor, memLimit/perBrowser, hardCap), ≥1.
 * Container-aware, so the same code is right locally and on any Railway size.
 */
export function autoConcurrency(opts: AutoConcurrencyOpts = {}): number {
  const env = opts.env ?? process.env;
  const override = Number(env.CLONE_CONCURRENCY);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const byCpu = Math.max(1, Math.floor(effectiveCpus() * (opts.coreFactor ?? 1.5)));
  const byMem = Math.max(1, Math.floor(memLimitMB() / (opts.perBrowserMb ?? 500)));
  return Math.max(1, Math.min(byCpu, byMem, opts.hardCap ?? 16));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/clone-engine && pnpm exec vitest run test/concurrency.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/concurrency.ts packages/clone-engine/test/concurrency.test.ts
git commit -m "feat(engine): mapPool + container-aware autoConcurrency"
```

---

## Task 2: async astro build (unblock the pool)

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts`

**Why:** the build shells out with `execSync`, which blocks the single Node thread — under a pool it would serialize every astro build, defeating parallelism. Switch to a promise over `spawn`.

- [ ] **Step 1: Add the helper near the top of `orchestrate.ts` and change the import**

Replace `import { execSync } from "node:child_process";` with `import { spawn } from "node:child_process";`, then add:

```ts
/** Promise over spawn; rejects on non-zero exit. Keeps the event loop free so
 *  pooled astro builds overlap. */
function run(cmd: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, stdio: "inherit", shell: "/bin/bash" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`command failed (exit ${code}): ${cmd}`)));
  });
}
```

- [ ] **Step 2: Replace the `execSync(...)` astro build call** with

```ts
await run(
  `ln -sf "${astroNodeModules}" node_modules && ./node_modules/.bin/astro build`,
  astroDir,
);
```

- [ ] **Step 3: Regression gate (still serial at this point)**

Run: `cd packages/clone-engine && pnpm exec vitest run test/astro-build.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/clone-engine/src/orchestrate.ts
git commit -m "refactor(engine): async spawn for astro build (unblocks pooled builds)"
```

---

## Task 3: parallelize the per-page loop

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts`
- Modify: `packages/clone-engine/src/report.ts`

- [ ] **Step 1: Add imports + a `concurrency` option to `BuildSiteOpts`**

Imports:

```ts
import { mapPool, autoConcurrency } from "./concurrency.ts";
```

Add to `BuildSiteOpts`:

```ts
  /** Max pages built concurrently. Defaults to autoConcurrency() (host-sized). */
  concurrency?: number;
```

- [ ] **Step 2: Extract the loop body into `buildOnePage()`**

Add this function (it is the current loop body, verbatim except: `execSync`→`await run(...)`, the per-page LLM accumulator snapshot removed, and it returns a result instead of pushing to outer arrays):

```ts
interface PageBuildResult { page: AugmentedPage; status: "ok" | "failed"; report?: PageReport; }

async function buildOnePage(ctx: {
  p: AugmentedPage; pageIdx: number; total: number; cwd: string; linksFile: string;
  runLlm: boolean; collectReport: boolean; reportOut?: string; astroNodeModules: string;
  emit: ReturnType<typeof makeEmit>;
}): Promise<PageBuildResult> {
  const { p, pageIdx, total, cwd, linksFile, runLlm, collectReport, reportOut, astroNodeModules, emit } = ctx;
  let captureMs = 0, labelMs = 0, projectMs = 0, buildMs = 0;
  try {
    emit({ type: "page.capture.started", route: p.route });
    const captureDir = path.join(cwd, p.dir);
    const captureJsonPath = path.join(captureDir, "capture.json");
    const captureCached = fs.existsSync(captureJsonPath);
    let freshCaptureMs: number | undefined;

    if (!captureCached) {
      console.log(`\n=== Page ${pageIdx + 1}/${total}: CAPTURE ${p.route} ===`);
      const t = Date.now();
      await capture({ url: p.url, out: captureDir, verify: false });
      captureMs = Date.now() - t; freshCaptureMs = captureMs;
    } else {
      console.log(`\n=== capture cached ${p.route} ===`);
    }
    emit({ type: "page.capture.done", route: p.route });

    let lblsForReport: Awaited<ReturnType<typeof label>>["labels"] | null = null;
    let pageLabelSource: LabelSource | "llm-cached" = "heuristic-disabled";
    let pageLabelFallbackReason: string | undefined;
    {
      const tLabel = Date.now();
      try {
        const captureJson = JSON.parse(fs.readFileSync(captureJsonPath, "utf8")) as CaptureJson;
        const labelsJsonPath = path.join(captureDir, "labels.json");
        if (runLlm) {
          if (!fs.existsSync(labelsJsonPath)) {
            const result = await label({ dir: captureDir, out: captureDir, llm: true });
            lblsForReport = result.labels; pageLabelSource = result.source; pageLabelFallbackReason = result.fallbackReason;
          } else {
            console.log(`=== label cached ${p.route} ===`);
            lblsForReport = JSON.parse(fs.readFileSync(labelsJsonPath, "utf8")) as typeof lblsForReport;
            pageLabelSource = "llm-cached";
          }
        } else {
          lblsForReport = heuristicLabels(captureJson);
          pageLabelSource = "heuristic-disabled";
        }
      } catch (e) {
        console.warn(`[orchestrate] label pass failed for ${p.route}: ${(e as Error).message}`);
      }
      labelMs = Date.now() - tLabel;
    }

    const base = p.route === "/" ? "" : p.route.replace(/\/$/, "");
    emit({ type: "page.project.started", route: p.route });
    console.log(`=== Page ${pageIdx + 1}/${total}: PROJECT ${p.route} (base='${base}') ===`);
    const tProject = Date.now();
    await project({ dir: captureDir, out: path.join(cwd, p.out), base, links: linksFile, noDiff: true });
    projectMs = Date.now() - tProject;
    emit({ type: "page.project.done", route: p.route });

    const astroDir = path.join(cwd, p.out, "astro");
    emit({ type: "page.build.started", route: p.route });
    const tBuild = Date.now();
    await run(`ln -sf "${astroNodeModules}" node_modules && ./node_modules/.bin/astro build`, astroDir);
    buildMs = Date.now() - tBuild;
    emit({ type: "page.build.done", route: p.route });

    let report: PageReport | undefined;
    if (collectReport) {
      const unknownSections = lblsForReport ? lblsForReport.sections.filter((s) => s.role === "unknown").length : 0;
      let leftoverSourceRefs = 0, assetCount: number | undefined, pageWeightKb: number | undefined;
      try {
        const cap = JSON.parse(fs.readFileSync(captureJsonPath, "utf8")) as { sourceOrigins?: string[]; assets?: unknown[] };
        leftoverSourceRefs = cap.sourceOrigins?.length ?? 0;
        if (Array.isArray(cap.assets)) assetCount = cap.assets.length;
      } catch { /* ignore */ }
      try {
        const builtIndex = path.join(cwd, p.out, "astro/dist/index.html");
        if (fs.existsSync(builtIndex)) pageWeightKb = Math.round(fs.statSync(builtIndex).size / 1024);
      } catch { /* ignore */ }
      const thumbAbs = path.join(captureDir, "source-desktop.png");
      const thumbPath = fs.existsSync(thumbAbs) && reportOut ? path.relative(path.dirname(reportOut), thumbAbs) : undefined;
      report = {
        route: p.route, status: "ok",
        timing: { route: p.route, captureMs, labelMs, projectMs, buildMs, captureCached, freshCaptureMs },
        llm: undefined, // per-page LLM cost is not attributable under concurrency; see run-level total
        issues: { assetsFailed: 0, leftoverSourceRefs, labelSource: pageLabelSource, labelFallbackReason: pageLabelFallbackReason, unknownSections, captureRetries: 0, selfContainmentWarnings: 0 },
        thumbPath, assetCount, pageWeightKb,
      };
    }
    return { page: p, status: "ok", report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`!!! FAILED ${p.route}: ${msg.split("\n")[0]}`);
    emit({ type: "page.failed", route: p.route, error: msg.split("\n")[0] });
    const report: PageReport | undefined = collectReport ? {
      route: p.route, status: "failed", error: msg,
      timing: { route: p.route, captureMs, labelMs, projectMs, buildMs, captureCached: false },
      issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "heuristic-disabled", unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
    } : undefined;
    return { page: p, status: "failed", report };
  }
}
```

- [ ] **Step 3: Replace the `for` loop in `buildSite()` with a pool**

Delete the whole `for (const [pageIdx, p] of augmented.entries()) { … }` block and the `ok`/`failed`/`pageReports` it filled, and insert:

```ts
  const concurrency = opts.concurrency ?? autoConcurrency();
  const astroNodeModules = path.resolve(
    import.meta.dirname, "../../../page-clone-spike/out-project-page/astro/node_modules",
  );
  console.log(`[build] concurrency=${concurrency} over ${augmented.length} page(s)`);

  const results = await mapPool(augmented, concurrency, (p, pageIdx) =>
    buildOnePage({ p, pageIdx, total: augmented.length, cwd, linksFile, runLlm, collectReport, reportOut: opts.reportOut, astroNodeModules, emit }));

  const ok: AugmentedPage[] = [];
  const failed: AugmentedPage[] = [];
  const pageReports: PageReport[] = [];
  for (const r of results) {
    (r.status === "ok" ? ok : failed).push(r.page);
    if (r.report) pageReports.push(r.report);
  }
```

Keep `runLlm` defined above this (`const runLlm = opts.llm !== false;`). The existing `if (ok.length === 0) throw …`, the assemble block, and the report-emit block all stay as-is (they consume `ok`/`pageReports`).

- [ ] **Step 4: Aggregate LLM cost into the report**

In `report.ts`, add to `BuildReport`:

```ts
  /** Whole-run LLM cost (per-page attribution isn't possible under concurrency).
   *  Present only when the LLM labeler ran. */
  totalLlmCostUsd?: number;
  totalLlmTokens?: { prompt: number; completion: number };
```

In `orchestrate.ts`, where the final `report` object is built, compute + include:

```ts
    const snap = accumulatorTotal(llmCostAccumulator.summary());
    const totalLlmTokens = (snap.promptTokens || snap.completionTokens)
      ? { prompt: snap.promptTokens, completion: snap.completionTokens } : undefined;
    const totalLlmCostUsd = totalLlmTokens ? computeLabelCost(snap.promptTokens, snap.completionTokens) : undefined;
```

Add `totalLlmCostUsd, totalLlmTokens` to the `report` literal.

- [ ] **Step 5: Full suite (parity gate)**

Run: `cd packages/clone-engine && pnpm test`
Expected: all pass, incl. `parity-capture` / `parity-project`.

- [ ] **Step 6: Real cold-build smoke + timing + fidelity**

Run: `node packages/clone-engine/src/cli.ts build-auto --site https://www.crossfitnewengland.com/ --out /tmp/cfne.html`
Expected: completes; log shows `concurrency=N`; `/tmp/cfne.json` `totalWallMs` ≈ `serial_total / N`; open a couple pages in `full-site/` and confirm they render identically to a serial build (never-regress rule).

- [ ] **Step 7: Commit**

```bash
git add packages/clone-engine/src/orchestrate.ts packages/clone-engine/src/report.ts
git commit -m "feat(engine): parallelize per-page build loop (host-sized concurrency)"
```

---

## Task 4: `--concurrency` CLI flag

**Files:**
- Modify: `packages/clone-engine/src/cli.ts`

- [ ] **Step 1: Parse `--concurrency` in `build-auto` and `build-site`**

In each case:

```ts
    const concStr = arg("concurrency");
    const concurrency = concStr ? parseInt(concStr, 10) : undefined;
```

Pass `concurrency` into the `buildSiteAuto(site, { … })` / `buildSite({ … })` opts. `BuildSiteAutoOpts extends Omit<BuildSiteOpts, …>`, so it forwards to the inner `buildSite` via the existing `...buildOpts` spread — confirm.

- [ ] **Step 2: Verify**

Run: `node packages/clone-engine/src/cli.ts build-auto --site https://www.crossfitnewengland.com/ --concurrency 4 --out /tmp/cfne4.html`
Expected: `concurrency=4`; completes.

- [ ] **Step 3: Railway sanity note (no code)** — confirm the admin path needs nothing: `apps/admin/src/jobs/runner.ts` spawns the CLI, and `autoConcurrency()` reads the container's cgroup limits at runtime, so a Railway deploy auto-sizes with zero admin change. To pin a value, set `CLONE_CONCURRENCY` in the Railway service env.

- [ ] **Step 4: Commit**

```bash
git add packages/clone-engine/src/cli.ts
git commit -m "feat(engine): --concurrency flag on build-auto/build-site"
```

---

## Self-Review

**Spec coverage:**
- Parallelize the per-page loop → Task 3. ✓
- Works well on Railway (container-aware sizing, OOM-safe) → Task 1 (`effectiveCpus`/`memLimitMB`) + Task 4 Step 3. ✓
- Real build parallelism (not blocked by execSync) → Task 2. ✓
- Concurrency-safe LLM cost → Task 3 Step 4. ✓
- Operator override → Task 1 (`CLONE_CONCURRENCY`) + Task 4 (`--concurrency`). ✓
- Byte-identical output guard → Task 3 Steps 5–6. ✓
- No storage/queue/distributed machinery → Non-goals; nothing in the tasks adds a dependency. ✓

**Type consistency:** `PageBuildResult` is produced and consumed only in Task 3 (buildOnePage → the reduce loop). `PageReport`/`PageIssues`/`PageTiming` fields match the existing `report.ts` shapes (reused verbatim from the current loop). `mapPool`/`autoConcurrency` signatures match Task 1. `run()` signature matches Task 2.

**Placeholder scan:** every code step is complete; the one prose step (Task 4 Step 3) is an intentional no-code verification note. ✓

**Concurrency-safety notes (verified against current code):**
- `links-site.json` is written once before the pool and only read during it. ✓
- Each page builds in its own `p.out/astro` dir with its own `node_modules` symlink → no cross-page collision. ✓
- `capture()` cleans only its own `assets/` dir. ✓
- `ok`/`failed`/`pageReports` are assembled from `mapPool` results after the barrier, not mutated concurrently. ✓
