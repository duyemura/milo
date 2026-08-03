> **STATUS: DEFERRED (2026-08-02).** Superseded for now by `2026-08-02-parallel-clone-local-and-railway.md`, which delivers the local+Railway speedup without the store/phase-split machinery. Revisit this (phase-split through the store) only when adopting the distributed model (Plan 3).

# Parallel Phase-Split Pipeline — Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the serial per-page build loop into a two-phase pipeline — capture-all (bounded, container-aware concurrency) → barrier → build/assemble-all — crossing the barrier through the `ArtifactStore` from Plan 1, cutting a cold 28-page build from ~23 min to ~3–4 min with byte-identical output.

**Architecture:** `buildSite()` splits into a **capture phase** (`capture()` + `label()` → `store.putDir(pageKey)`, run over a bounded async pool sized by `autoConcurrency()`), a **barrier**, and a **build phase** (`store.getDir(pageKey)` → `project()` → async `astro build`, also pooled) followed by assemble + report. The store round-trip is the same code path Plan 3 distributes; locally it is a cheap `FsArtifactStore` copy. Capture progress events are emitted by the coordinator around each page so they work unchanged when Plan 3 moves capture onto workers.

**Tech Stack:** Node 24, TypeScript, Playwright, Astro (async `spawn`), `@milo/clone-engine` store seam (Plan 1), Vitest.

**Depends on:** Plan 1 (`ArtifactStore`, `artifactStoreFromEnv`). **Precedes:** Plan 3 (distributed queue).

**Parity note:** output must be byte-identical to today. The existing `test/parity-capture.test.ts` / `test/parity-project.test.ts` and the fidelity oracle are the guardrail — this plan changes *scheduling*, not capture/project logic.

---

## File Structure

- `packages/clone-engine/src/concurrency.ts` (**create**) — `autoConcurrency()` (container-aware) + `mapPool()` (bounded async map).
- `packages/clone-engine/src/keys.ts` (**create**) — `pageKey(runId, pageSlug)` + `newRunId(origin)`.
- `packages/clone-engine/src/orchestrate.ts` (**modify**) — split the loop into `capturePhase` + `buildPhase`; inject the store; async astro build; aggregate LLM cost.
- `packages/clone-engine/src/report.ts` (**modify**) — add run-level `totalLlmCostUsd`/`totalLlmTokens` (per-page LLM attribution is dropped — it cannot be computed race-free under concurrency).
- `packages/clone-engine/src/cli.ts` (**modify**) — `--concurrency N` flag on `build-auto`/`build-site`.
- `packages/clone-engine/test/concurrency.test.ts` (**create**) — pool + autoConcurrency unit tests.
- `packages/clone-engine/test/keys.test.ts` (**create**) — key derivation tests.
- `packages/clone-engine/test/orchestrate-phases.test.ts` (**create**) — phase-split behavior with a stub store + stubbed capture/project.

---

## Task 1: `mapPool` + `autoConcurrency`

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
});

describe("autoConcurrency", () => {
  it("honors an explicit CLONE_CONCURRENCY override", () => {
    expect(autoConcurrency({ env: { CLONE_CONCURRENCY: "7" } })).toBe(7);
  });
  it("clamps to at least 1 and at most the hard cap", () => {
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
 * Run `fn` over `items` with at most `limit` concurrent invocations. Results are
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

/** vCPUs available to THIS process. Reads cgroup v2 quota so it is correct inside
 *  a container (os.availableParallelism reports the HOST core count). */
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
  /** Cores × this = CPU-bound ceiling. >1 because capture is ~40% idle wait. Default 1.5. */
  coreFactor?: number;
  /** Absolute ceiling regardless of hardware. Default 16. */
  hardCap?: number;
}

/**
 * Concurrency for the capture phase, sized to the host. `CLONE_CONCURRENCY` env
 * overrides everything. Otherwise: min(cores×coreFactor, memLimit/perBrowser, hardCap),
 * floored at 1. Container-aware via effectiveCpus()/memLimitMB().
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
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/concurrency.ts packages/clone-engine/test/concurrency.test.ts
git commit -m "feat(engine): mapPool + container-aware autoConcurrency"
```

---

## Task 2: page key derivation

**Files:**
- Create: `packages/clone-engine/src/keys.ts`
- Test: `packages/clone-engine/test/keys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { pageKey, newRunId } from "../src/keys.ts";

describe("pageKey", () => {
  it("namespaces a page under its run", () => {
    expect(pageKey("run-abc", "ks-home")).toBe("runs/run-abc/pages/ks-home");
  });
});
describe("newRunId", () => {
  it("is prefixed by the origin slug and unique per call", () => {
    const a = newRunId("crossfit-buckhead");
    const b = newRunId("crossfit-buckhead");
    expect(a.startsWith("crossfit-buckhead-")).toBe(true);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/keys.test.ts`
Expected: FAIL — cannot resolve `../src/keys.ts`.

- [ ] **Step 3: Write the implementation**

```ts
/** Stable store key for a page's artifact directory within a run. */
export function pageKey(runId: string, pageSlug: string): string {
  return `runs/${runId}/pages/${pageSlug}`;
}

/** A run id namespacing all page artifacts for one build. Origin-prefixed for
 *  legibility in the store; suffix is time + random for uniqueness. */
export function newRunId(originSlug: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${originSlug}-${Date.now().toString(36)}-${rand}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/clone-engine && pnpm exec vitest run test/keys.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/keys.ts packages/clone-engine/test/keys.test.ts
git commit -m "feat(engine): pageKey + newRunId helpers"
```

---

## Task 3: async astro build helper

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts`

**Why:** the current build shells out with `execSync`, which **blocks the event loop** — under a concurrency pool it would serialize every astro build. Replace with a promise-returning `spawn` so pooled builds run truly concurrently.

- [ ] **Step 1: Add an async spawn helper near the top of `orchestrate.ts`**

```ts
import { spawn } from "node:child_process";

/** Promise wrapper over spawn; rejects on non-zero exit. Replaces execSync so the
 *  event loop stays free and pooled astro builds run concurrently. */
function run(cmd: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, stdio: "inherit", shell: "/bin/bash" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`command failed (exit ${code}): ${cmd}`)));
  });
}
```

- [ ] **Step 2: Replace the `execSync(...)` astro build call**

Change (inside the build path):

```ts
execSync(
  `ln -sf "${astroNodeModules}" node_modules && ./node_modules/.bin/astro build`,
  { cwd: astroDir, stdio: "inherit", shell: "/bin/bash" },
);
```

to:

```ts
await run(
  `ln -sf "${astroNodeModules}" node_modules && ./node_modules/.bin/astro build`,
  astroDir,
);
```

- [ ] **Step 3: Drop the now-unused `execSync` import** (leave `spawn`).

- [ ] **Step 4: Verify the serial build still passes end-to-end** (regression gate before the split)

Run: `cd packages/clone-engine && pnpm exec vitest run test/astro-build.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/orchestrate.ts
git commit -m "refactor(engine): async spawn for astro build (unblocks pooled builds)"
```

---

## Task 4: split `buildSite` into capture + build phases

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts`
- Modify: `packages/clone-engine/src/report.ts`
- Test: `packages/clone-engine/test/orchestrate-phases.test.ts`

This is the core task. It replaces the single `for` loop in `buildSite()` with `capturePhase` → barrier → `buildPhase` → assemble → report, using an injected `ArtifactStore` and `mapPool`.

- [ ] **Step 1: Extend `BuildSiteOpts` (in `orchestrate.ts`)**

Add fields:

```ts
  /** Bounded capture/build concurrency. Defaults to autoConcurrency(). */
  concurrency?: number;
  /** Artifact store for the capture→build barrier. Defaults to artifactStoreFromEnv(). */
  store?: ArtifactStore;
  /** Run id namespacing store keys. Defaults to newRunId(originSlug(origin)). */
  runId?: string;
```

and the imports:

```ts
import { mapPool, autoConcurrency } from "./concurrency.ts";
import { pageKey, newRunId } from "./keys.ts";
import { artifactStoreFromEnv, type ArtifactStore } from "./store/index.ts";
```

- [ ] **Step 2: Add the capture-phase outcome type and function**

```ts
interface CaptureOutcome {
  page: AugmentedPage;
  status: "ok" | "failed";
  error?: string;
  captureMs: number;
  labelMs: number;
  captureCached: boolean;
  freshCaptureMs?: number;
  labelSource: LabelSource | "llm-cached";
  labelFallbackReason?: string;
  labels: Labels | null;
}

/** Capture + label every page over a bounded pool; push each page's artifact dir
 *  to the store. Progress events are emitted here (coordinator side) so Plan 3 can
 *  move the work onto workers without changing the event stream. Never throws per
 *  page — failures are returned as status:"failed". */
async function capturePhase(ctx: {
  pages: AugmentedPage[]; cwd: string; store: ArtifactStore; runId: string;
  concurrency: number; runLlm: boolean; emit: ReturnType<typeof makeEmit>;
}): Promise<CaptureOutcome[]> {
  const { pages, cwd, store, runId, concurrency, runLlm, emit } = ctx;
  return mapPool(pages, concurrency, async (p) => {
    const scratch = path.join(cwd, p.dir);
    const key = pageKey(runId, p.out);
    try {
      emit({ type: "page.capture.started", route: p.route });
      let captureMs = 0, freshCaptureMs: number | undefined, captureCached = false;
      let labelSource: LabelSource | "llm-cached" = "heuristic-disabled";
      let labelFallbackReason: string | undefined;
      let labels: Labels | null = null;

      if (await store.exists(key)) {
        // Fully captured+labeled in a prior run — pull it down; skip capture + label.
        await store.getDir(key, scratch);
        captureCached = true;
        labelSource = "llm-cached";
        const lp = path.join(scratch, "labels.json");
        if (fs.existsSync(lp)) labels = JSON.parse(fs.readFileSync(lp, "utf8")) as Labels;
        emit({ type: "page.capture.done", route: p.route });
        return { page: p, status: "ok", captureMs, labelMs: 0, captureCached, labelSource, labels };
      }

      const tCap = Date.now();
      await capture({ url: p.url, out: scratch, verify: false });
      captureMs = Date.now() - tCap; freshCaptureMs = captureMs;
      emit({ type: "page.capture.done", route: p.route });

      const tLbl = Date.now();
      try {
        const result = await label({ dir: scratch, out: scratch, llm: runLlm });
        labels = result.labels; labelSource = result.source; labelFallbackReason = result.fallbackReason;
      } catch (e) {
        console.warn(`[orchestrate] label failed for ${p.route}: ${(e as Error).message}`);
      }
      const labelMs = Date.now() - tLbl;

      await store.putDir(key, scratch);
      return { page: p, status: "ok", captureMs, labelMs, captureCached, freshCaptureMs, labelSource, labelFallbackReason, labels };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ type: "page.failed", route: p.route, error: msg.split("\n")[0] });
      return { page: p, status: "failed", error: msg, captureMs: 0, labelMs: 0, captureCached: false, labelSource: "heuristic-disabled", labels: null };
    }
  });
}
```

- [ ] **Step 3: Add the build-phase outcome type and function**

```ts
interface BuildOutcome {
  page: AugmentedPage;
  status: "ok" | "failed";
  error?: string;
  projectMs: number;
  buildMs: number;
}

/** Project + astro-build every successfully-captured page over a bounded pool.
 *  Pulls the page's artifact dir from the store first (a no-op copy locally, a real
 *  download in distributed mode). Never throws per page. */
async function buildPhase(ctx: {
  captured: CaptureOutcome[]; cwd: string; store: ArtifactStore; runId: string;
  concurrency: number; linksFile: string; astroNodeModules: string;
  emit: ReturnType<typeof makeEmit>;
}): Promise<BuildOutcome[]> {
  const { captured, cwd, store, runId, concurrency, linksFile, astroNodeModules, emit } = ctx;
  const okCaps = captured.filter((c) => c.status === "ok");
  return mapPool(okCaps, concurrency, async (c) => {
    const p = c.page;
    const scratch = path.join(cwd, p.dir);
    try {
      if (!fs.existsSync(path.join(scratch, "capture.json"))) {
        await store.getDir(pageKey(runId, p.out), scratch);
      }
      const base = p.route === "/" ? "" : p.route.replace(/\/$/, "");
      emit({ type: "page.project.started", route: p.route });
      const tProj = Date.now();
      await project({ dir: scratch, out: path.join(cwd, p.out), base, links: linksFile, noDiff: true });
      const projectMs = Date.now() - tProj;
      emit({ type: "page.project.done", route: p.route });

      const astroDir = path.join(cwd, p.out, "astro");
      emit({ type: "page.build.started", route: p.route });
      const tBuild = Date.now();
      await run(`ln -sf "${astroNodeModules}" node_modules && ./node_modules/.bin/astro build`, astroDir);
      const buildMs = Date.now() - tBuild;
      emit({ type: "page.build.done", route: p.route });
      return { page: p, status: "ok", projectMs, buildMs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ type: "page.failed", route: p.route, error: msg.split("\n")[0] });
      return { page: p, status: "failed", error: msg, projectMs: 0, buildMs: 0 };
    }
  });
}
```

- [ ] **Step 4: Rewrite the body of `buildSite()` to orchestrate the phases**

Replace the entire `for (const [pageIdx, p] of augmented.entries()) { … }` loop (and the `ok`/`failed`/`pageReports` accumulation inside it) with:

```ts
  const store = opts.store ?? artifactStoreFromEnv();
  const runId = opts.runId ?? newRunId(slug);
  const concurrency = opts.concurrency ?? autoConcurrency();
  const runLlm = opts.llm !== false;
  const astroNodeModules = path.resolve(
    import.meta.dirname, "../../../page-clone-spike/out-project-page/astro/node_modules",
  );
  console.log(`[build] runId=${runId} concurrency=${concurrency} store=${store.constructor.name}`);

  // Phase 1: capture + label (bounded pool), barrier on completion.
  const captured = await capturePhase({ pages: augmented, cwd, store, runId, concurrency, runLlm, emit });

  if (captured.every((c) => c.status === "failed")) {
    throw new Error(`buildSite: all ${augmented.length} page(s) failed capture — no site to assemble`);
  }

  // Phase 2: project + astro build (bounded pool).
  const built = await buildPhase({ captured, cwd, store, runId, concurrency, linksFile, astroNodeModules, emit });

  // Reconcile ok/failed across both phases (a page is ok only if BOTH phases succeeded).
  const builtOkSlugs = new Set(built.filter((b) => b.status === "ok").map((b) => b.page.out));
  const ok: AugmentedPage[] = augmented.filter((p) => builtOkSlugs.has(p.out));
  const failed: AugmentedPage[] = augmented.filter((p) => !builtOkSlugs.has(p.out));

  if (ok.length === 0) {
    throw new Error(`buildSite: all ${augmented.length} page(s) failed — no site to assemble`);
  }
```

Then keep the **existing assemble block unchanged** (it iterates `ok` and `fs.cpSync` from `astro/dist` into `full-site/`).

- [ ] **Step 5: Rebuild `pageReports` from the two outcome arrays**

After assemble, before `generateHtmlReport`, replace the old inline `pageReports.push(...)` with a merge keyed by route (only when `collectReport`):

```ts
  if (collectReport) {
    const buildBySlug = new Map(built.map((b) => [b.page.out, b]));
    for (const c of captured) {
      const p = c.page;
      const b = buildBySlug.get(p.out);
      const scratch = path.join(cwd, p.dir);
      const captureJsonPath = path.join(scratch, "capture.json");
      const status: PageReport["status"] = c.status === "ok" && b?.status === "ok" ? "ok" : "failed";

      let leftoverSourceRefs = 0, assetCount: number | undefined, pageWeightKb: number | undefined;
      try {
        const cap = JSON.parse(fs.readFileSync(captureJsonPath, "utf8")) as { sourceOrigins?: string[]; assets?: unknown[] };
        leftoverSourceRefs = cap.sourceOrigins?.length ?? 0;
        if (Array.isArray(cap.assets)) assetCount = cap.assets.length;
      } catch { /* capture failed — no json */ }
      try {
        const builtIndex = path.join(cwd, p.out, "astro/dist/index.html");
        if (fs.existsSync(builtIndex)) pageWeightKb = Math.round(fs.statSync(builtIndex).size / 1024);
      } catch { /* */ }
      const thumbAbs = path.join(scratch, "source-desktop.png");
      const thumbPath = fs.existsSync(thumbAbs) ? path.relative(path.dirname(opts.reportOut!), thumbAbs) : undefined;
      const unknownSections = c.labels ? c.labels.sections.filter((s) => s.role === "unknown").length : 0;

      pageReports.push({
        route: p.route,
        status,
        error: c.error ?? b?.error,
        timing: { route: p.route, captureMs: c.captureMs, labelMs: c.labelMs, projectMs: b?.projectMs ?? 0, buildMs: b?.buildMs ?? 0, captureCached: c.captureCached, freshCaptureMs: c.freshCaptureMs },
        llm: undefined, // per-page LLM cost cannot be attributed race-free under concurrency; see run-level total
        issues: { assetsFailed: 0, leftoverSourceRefs, labelSource: c.labelSource, labelFallbackReason: c.labelFallbackReason, unknownSections, captureRetries: 0, selfContainmentWarnings: 0 },
        thumbPath, assetCount, pageWeightKb,
      });
    }
  }
```

- [ ] **Step 6: Add run-level LLM cost to the report**

In `report.ts`, add to the `BuildReport` interface:

```ts
  /** Aggregate LLM cost for the whole run (per-page attribution is not possible
   *  under concurrency). Present only when the LLM labeler ran. */
  totalLlmCostUsd?: number;
  totalLlmTokens?: { prompt: number; completion: number };
```

In `orchestrate.ts`, when building the final `report` object, compute from the accumulator:

```ts
    const snap = accumulatorTotal(llmCostAccumulator.summary());
    const totalLlmTokens = (snap.promptTokens || snap.completionTokens)
      ? { prompt: snap.promptTokens, completion: snap.completionTokens } : undefined;
    const totalLlmCostUsd = totalLlmTokens ? computeLabelCost(snap.promptTokens, snap.completionTokens) : undefined;
```

and include `totalLlmCostUsd, totalLlmTokens` in the `report` literal.

- [ ] **Step 7: Write the phase-split behavior test** (stub store + stubbed capture/project via a small seam)

`test/orchestrate-phases.test.ts` — drive `buildSite` with `concurrency: 2`, an in-memory-ish `FsArtifactStore` pointed at a temp dir, and a fake origin whose pages resolve to pre-seeded capture dirs. Assert: (a) all pages assemble into `full-site/`, (b) `store.exists(pageKey)` is true for each page afterward, (c) a second run with the same store skips capture (cached path). (Full fixture code written during execution against the real `capture()` stub seam — capture is Playwright-bound, so this test seeds capture dirs and asserts phase orchestration, not live capture.)

> **Revision note:** the exact stubbing seam for `capture()` is TBD until execution — if `capture()` is not easily injectable, add a `captureFn`/`projectFn` option to `BuildSiteOpts` (defaulting to the real ones) purely to make the phases testable. Decide at execution; update this task.

- [ ] **Step 8: Run the full suite (with MinIO up for the S3 path)**

Run: `docker compose up -d && cd packages/clone-engine && pnpm test`
Expected: all pass, including existing parity tests.

- [ ] **Step 9: Real cold-build smoke + timing**

Run: `node packages/clone-engine/src/cli.ts build-auto --site https://www.crossfitnewengland.com/ --out /tmp/cfne-report.html`
Expected: completes; `/tmp/cfne-report.json` `totalWallMs` roughly `≈ (serial_total / concurrency)`; `full-site/` present. Eyeball a page in `full-site/` for fidelity (never-regress rule).

- [ ] **Step 10: Commit**

```bash
git add packages/clone-engine/src/orchestrate.ts packages/clone-engine/src/report.ts packages/clone-engine/test/orchestrate-phases.test.ts
git commit -m "feat(engine): phase-split parallel pipeline (capture-all → barrier → build-all)"
```

---

## Task 5: `--concurrency` CLI flag

**Files:**
- Modify: `packages/clone-engine/src/cli.ts`

- [ ] **Step 1: Parse `--concurrency` in `build-auto` and `build-site`**

In the `build-auto` case add:

```ts
    const concStr = arg("concurrency");
    const concurrency = concStr ? parseInt(concStr, 10) : undefined;
```

and pass `concurrency` into the `buildSiteAuto(site, { … })` opts. Do the same for the `build-site` case.

- [ ] **Step 2: Thread `concurrency` through `buildSiteAuto`**

`BuildSiteAutoOpts extends Omit<BuildSiteOpts, "pages" | "origin">`, so `concurrency` already flows to the inner `buildSite` calls. Confirm both `buildSite({...buildOpts, ...})` calls forward it (they spread `buildOpts`).

- [ ] **Step 3: Verify**

Run: `node packages/clone-engine/src/cli.ts build-auto --site https://www.crossfitnewengland.com/ --concurrency 4 --out /tmp/cfne4.html`
Expected: log shows `concurrency=4`; completes.

- [ ] **Step 4: Commit**

```bash
git add packages/clone-engine/src/cli.ts
git commit -m "feat(engine): --concurrency flag on build-auto/build-site"
```

---

## Self-Review

**Spec coverage:**
- Phase split capture→barrier→build → Task 4. ✓
- Bounded, container-aware concurrency → Task 1 + Task 4 (`autoConcurrency`, `mapPool`). ✓
- Store round-trip at the barrier (Plan 1 seam, Plan 3-ready) → Task 4 (`putDir`/`getDir`). ✓
- Async astro build (real build parallelism) → Task 3. ✓
- Capture cache preserved (now store-keyed) → Task 4 Step 2 (`store.exists`). ✓
- Coordinator-side events (Plan 3-ready) → Task 4 Steps 2–3. ✓
- Concurrency-safe LLM cost → Task 4 Step 6 (aggregate run-level; per-page dropped, documented). ✓
- CLI knob → Task 5. ✓
- Never-regress guardrail → Task 4 Steps 8–9 (parity tests + fidelity eyeball). ✓

**Type consistency:** `CaptureOutcome`/`BuildOutcome` fields are consumed exactly as produced in Task 4 Step 5's report merge. `pageKey(runId, p.out)` uses `p.out` (the existing per-page slug) consistently in both phases. `mapPool`/`autoConcurrency` signatures match Task 1. `ArtifactStore` methods match Plan 1.

**Known revision points (flagged for between-section revision):**
1. Task 4 Step 7 — the `capture()`/`project()` test seam may need a `captureFn`/`projectFn` injection option; decide at execution.
2. Per-page LLM cost is dropped; if the build report needs it back, the clean fix is to have `label()` return token usage (touches `labels.ts` + `@milo/llm`) — a separate small change, not in this plan.
3. Local double-copy (capture→store→build scratch) is accepted overhead for parity; if it ever matters, `FsArtifactStore` could special-case same-path.
