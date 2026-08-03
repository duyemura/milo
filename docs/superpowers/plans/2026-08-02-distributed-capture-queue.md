> **STATUS: DEFERRED (2026-08-02).** For when we want wall time flat in page count across multiple worker replicas (Railway/EC2). Not needed for single-instance parallelization. The live plan is `2026-08-02-parallel-clone-local-and-railway.md`.

# Distributed Capture Queue — Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-page capture a distributable unit of work so wall time scales with worker replicas instead of page count — the same pipeline runs in-process locally and across BullMQ worker replicas in prod, selected by one env var.

**Architecture:** Extract Plan 2's per-page capture body into a pure `runCapturePage(job, store, scratchRoot)`. Introduce a `CaptureQueue` seam (mirroring `apps/admin/src/jobs/queue.ts`): `localCaptureQueue` runs `runCapturePage` in-process; `bullmqCaptureQueue` enqueues a job and awaits its result while a separate worker process runs `runCapturePage`. The coordinator (`buildSite`) calls `queue.capturePage(job)` per page — bounded by `autoConcurrency()` locally, by worker count in prod — then, after the barrier, runs project/build/assemble locally (pulling each page's artifacts from the shared store). Capture is 85% of wall time and is the only thing distributed; project/build/assemble (≈4%) stay on the coordinator.

**Tech Stack:** Node 24, TypeScript, BullMQ + IORedis (already used by `@milo/admin`), Redis (docker-compose from Plan 1), `ArtifactStore` (Plan 1, must be `s3` in distributed mode), Vitest.

**Depends on:** Plan 1 (store) + Plan 2 (phases, `mapPool`, `runId`/`pageKey`, async build). **Deployment target:** Railway/EC2 with ≥1 worker replica; **local dev is unchanged in behavior** (defaults to the in-process queue).

**Hard requirement in distributed mode:** the store MUST be shared (`ARTIFACT_STORE=s3`). A worker capturing to `FsArtifactStore` on its own container is invisible to the coordinator. The factory in Task 6 enforces this.

---

## File Structure

- `packages/clone-engine/src/capture-job.ts` (**create**) — `CapturePageJob`, `CapturePageResult`, `runCapturePage()` (the extracted per-page body).
- `packages/clone-engine/src/queue/types.ts` (**create**) — `CaptureQueue` interface.
- `packages/clone-engine/src/queue/local.ts` (**create**) — `localCaptureQueue`.
- `packages/clone-engine/src/queue/bullmq.ts` (**create**) — `bullmqCaptureQueue` (producer side).
- `packages/clone-engine/src/queue/worker.ts` (**create**) — BullMQ worker: consumes capture jobs.
- `packages/clone-engine/src/queue/factory.ts` (**create**) — `captureQueueFromEnv()`.
- `packages/clone-engine/src/queue/index.ts` (**create**) — barrel.
- `packages/clone-engine/src/orchestrate.ts` (**modify**) — `capturePhase` calls `queue.capturePage` instead of inlining capture+label; read `unknownSections` from `labels.json` on disk.
- `packages/clone-engine/src/cli.ts` (**modify**) — `--queue local|bullmq` on build commands + a new `worker` subcommand.
- `packages/clone-engine/package.json` (**modify**) — add `bullmq` + `ioredis`; export `./queue`.
- `packages/clone-engine/test/capture-job.test.ts` (**create**) — `runCapturePage` against a stub store.
- `packages/clone-engine/test/queue-local.test.ts` (**create**) — `localCaptureQueue` delegates to `runCapturePage`.
- `packages/clone-engine/test/queue-bullmq.test.ts` (**create**) — round-trip through Redis (skipped when Redis is down).
- `docs/clone-engine-scaling.md` (**create**) — deployment/runbook (Railway + EC2 worker replicas).

---

## Task 1: extract `runCapturePage` (the distributable unit)

**Files:**
- Create: `packages/clone-engine/src/capture-job.ts`
- Test: `packages/clone-engine/test/capture-job.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCapturePage } from "../src/capture-job.ts";
import { FsArtifactStore } from "../src/store/fs-store.ts";

describe("runCapturePage", () => {
  let storeRoot: string, scratchRoot: string;
  beforeEach(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cj-store-"));
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cj-scratch-"));
  });
  afterEach(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("returns cached without re-capturing when the page key exists in the store", async () => {
    const store = new FsArtifactStore(storeRoot);
    // Pre-seed the store with a captured page.
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "cj-seed-"));
    fs.writeFileSync(path.join(seed, "capture.json"), "{}");
    fs.writeFileSync(path.join(seed, "labels.json"), '{"sections":[]}');
    await store.putDir("runs/r1/pages/home", seed);
    fs.rmSync(seed, { recursive: true, force: true });

    const res = await runCapturePage(
      { runId: "r1", route: "/", url: "http://example.test/", dir: "home", pageSlug: "home", llm: false },
      store, scratchRoot,
    );
    expect(res.status).toBe("ok");
    expect(res.captureCached).toBe(true);
    expect(res.labelSource).toBe("llm-cached");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/capture-job.test.ts`
Expected: FAIL — cannot resolve `../src/capture-job.ts`.

- [ ] **Step 3: Write the implementation** (this is Plan 2's `capturePhase` per-page body, extracted; NO emit here — the coordinator emits)

```ts
import fs from "node:fs";
import path from "node:path";
import { capture } from "./capture.ts";
import { label } from "./labels.ts";
import type { LabelSource } from "./labels.ts";
import { pageKey } from "./keys.ts";
import type { ArtifactStore } from "./store/index.ts";

/** Everything a worker needs to capture one page. Must be JSON-serializable
 *  (it travels through Redis). No large payloads — labels stay in the store. */
export interface CapturePageJob {
  runId: string;
  route: string;
  url: string;
  /** Local scratch subdir name (matches AugmentedPage.dir). */
  dir: string;
  /** Store-key slug (matches AugmentedPage.out). */
  pageSlug: string;
  llm: boolean;
}

/** Small, serializable outcome. Labels are NOT included — read labels.json from
 *  the store when needed (keeps Redis payloads small). */
export interface CapturePageResult {
  route: string;
  pageSlug: string;
  status: "ok" | "failed";
  error?: string;
  captureMs: number;
  labelMs: number;
  captureCached: boolean;
  freshCaptureMs?: number;
  labelSource: LabelSource | "llm-cached";
  labelFallbackReason?: string;
}

/** Capture + label one page and push its artifact dir to the store. Pure w.r.t.
 *  progress events — the caller emits. Never throws: failures come back as status. */
export async function runCapturePage(
  job: CapturePageJob,
  store: ArtifactStore,
  scratchRoot: string,
): Promise<CapturePageResult> {
  const scratch = path.join(scratchRoot, job.dir);
  const key = pageKey(job.runId, job.pageSlug);
  const base = { route: job.route, pageSlug: job.pageSlug };
  try {
    if (await store.exists(key)) {
      return { ...base, status: "ok", captureMs: 0, labelMs: 0, captureCached: true, labelSource: "llm-cached" };
    }
    const tCap = Date.now();
    await capture({ url: job.url, out: scratch, verify: false });
    const captureMs = Date.now() - tCap;

    const tLbl = Date.now();
    let labelSource: LabelSource | "llm-cached" = "heuristic-disabled";
    let labelFallbackReason: string | undefined;
    try {
      const r = await label({ dir: scratch, out: scratch, llm: job.llm });
      labelSource = r.source; labelFallbackReason = r.fallbackReason;
    } catch (e) {
      console.warn(`[capture-job] label failed for ${job.route}: ${(e as Error).message}`);
    }
    const labelMs = Date.now() - tLbl;

    await store.putDir(key, scratch);
    return { ...base, status: "ok", captureMs, labelMs, captureCached: false, freshCaptureMs: captureMs, labelSource, labelFallbackReason };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, status: "failed", error: msg, captureMs: 0, labelMs: 0, captureCached: false, labelSource: "heuristic-disabled" };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/clone-engine && pnpm exec vitest run test/capture-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/capture-job.ts packages/clone-engine/test/capture-job.test.ts
git commit -m "feat(engine): runCapturePage — extracted distributable capture unit"
```

---

## Task 2: `CaptureQueue` interface + `localCaptureQueue`

**Files:**
- Create: `packages/clone-engine/src/queue/types.ts`
- Create: `packages/clone-engine/src/queue/local.ts`
- Test: `packages/clone-engine/test/queue-local.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localCaptureQueue } from "../src/queue/local.ts";
import { FsArtifactStore } from "../src/store/fs-store.ts";

describe("localCaptureQueue", () => {
  let storeRoot: string, scratchRoot: string;
  beforeEach(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ql-store-"));
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ql-scratch-"));
  });
  afterEach(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("delegates to runCapturePage (cached path)", async () => {
    const store = new FsArtifactStore(storeRoot);
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "ql-seed-"));
    fs.writeFileSync(path.join(seed, "capture.json"), "{}");
    await store.putDir("runs/r1/pages/home", seed);
    fs.rmSync(seed, { recursive: true, force: true });

    const q = localCaptureQueue(store, scratchRoot);
    const res = await q.capturePage({ runId: "r1", route: "/", url: "http://x.test/", dir: "home", pageSlug: "home", llm: false });
    expect(res.status).toBe("ok");
    expect(res.captureCached).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/queue-local.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write `types.ts` and `local.ts`**

`queue/types.ts`:

```ts
import type { CapturePageJob, CapturePageResult } from "../capture-job.ts";

/** Producer-side capture queue. Concurrency is the adapter's/infra's concern:
 *  in-process it's bounded by the coordinator's mapPool width; in BullMQ it's
 *  bounded by worker replicas × worker concurrency. */
export interface CaptureQueue {
  capturePage(job: CapturePageJob): Promise<CapturePageResult>;
  /** Release backing connections (Redis). No-op for the local queue. */
  close(): Promise<void>;
}
```

`queue/local.ts`:

```ts
import { runCapturePage } from "../capture-job.ts";
import type { ArtifactStore } from "../store/index.ts";
import type { CaptureQueue } from "./types.ts";

/** In-process queue: runs capture inline. Coordinator bounds concurrency via mapPool. */
export function localCaptureQueue(store: ArtifactStore, scratchRoot: string): CaptureQueue {
  return {
    capturePage: (job) => runCapturePage(job, store, scratchRoot),
    close: async () => {},
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/clone-engine && pnpm exec vitest run test/queue-local.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/queue/types.ts packages/clone-engine/src/queue/local.ts packages/clone-engine/test/queue-local.test.ts
git commit -m "feat(engine): CaptureQueue seam + localCaptureQueue"
```

---

## Task 3: add `bullmq` + `ioredis` deps and `./queue` export

**Files:**
- Modify: `packages/clone-engine/package.json`

- [ ] **Step 1: Add deps + export**

Add to `dependencies` (match the versions `@milo/admin` resolves):

```json
    "bullmq": "^5.0.0",
    "ioredis": "^5.0.0"
```

Add to `exports`:

```json
    "./queue": "./src/queue/index.ts"
```

- [ ] **Step 2: Install + commit**

Run: `pnpm install`

```bash
git add packages/clone-engine/package.json pnpm-lock.yaml
git commit -m "chore(engine): add bullmq + ioredis; ./queue export"
```

---

## Task 4: `bullmqCaptureQueue` (producer) + `worker`

**Files:**
- Create: `packages/clone-engine/src/queue/bullmq.ts`
- Create: `packages/clone-engine/src/queue/worker.ts`
- Test: `packages/clone-engine/test/queue-bullmq.test.ts`

- [ ] **Step 1: Write the failing round-trip test (skipped without Redis)**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bullmqCaptureQueue } from "../src/queue/bullmq.ts";
import { startCaptureWorker } from "../src/queue/worker.ts";
import { FsArtifactStore } from "../src/store/fs-store.ts";

const REDIS = process.env.REDIS_URL ?? "redis://localhost:6379";
async function redisUp(): Promise<boolean> {
  try {
    const { default: IORedis } = await import("ioredis");
    const c = new IORedis(REDIS, { maxRetriesPerRequest: 1, lazyConnect: true });
    await c.connect(); await c.quit(); return true;
  } catch { return false; }
}

describe("bullmqCaptureQueue round-trip", async () => {
  const up = await redisUp();

  it.skipIf(!up)("enqueues a job, worker runs it, producer receives the result", async () => {
    // NOTE: shared FsArtifactStore only works because worker + producer are the SAME
    // process here (in-process test). In real deployment this MUST be S3.
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qb-store-"));
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qb-scratch-"));
    const store = new FsArtifactStore(storeRoot);
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "qb-seed-"));
    fs.writeFileSync(path.join(seed, "capture.json"), "{}");
    await store.putDir("runs/r1/pages/home", seed); // pre-seed → cached path, no real browser

    const worker = startCaptureWorker({ redisUrl: REDIS, store, scratchRoot, concurrency: 2 });
    const queue = bullmqCaptureQueue({ redisUrl: REDIS });
    const res = await queue.capturePage({ runId: "r1", route: "/", url: "http://x.test/", dir: "home", pageSlug: "home", llm: false });

    expect(res.status).toBe("ok");
    expect(res.captureCached).toBe(true);

    await queue.close(); await worker.close();
    [storeRoot, scratchRoot, seed].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/queue-bullmq.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write `bullmq.ts` (producer)**

```ts
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import type { CapturePageJob, CapturePageResult } from "../capture-job.ts";
import type { CaptureQueue } from "./types.ts";

export const CAPTURE_QUEUE_NAME = "milo-capture";

/** Producer side: enqueue a capture job and await its result via QueueEvents.
 *  Concurrency is bounded by the worker fleet, not here — the coordinator may
 *  enqueue all pages at once. */
export function bullmqCaptureQueue(opts: { redisUrl: string }): CaptureQueue {
  const connection = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(CAPTURE_QUEUE_NAME, { connection });
  const events = new QueueEvents(CAPTURE_QUEUE_NAME, { connection: new IORedis(opts.redisUrl, { maxRetriesPerRequest: null }) });

  return {
    async capturePage(job: CapturePageJob): Promise<CapturePageResult> {
      try {
        const j = await queue.add("capture", job, {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 2,
          backoff: { type: "fixed", delay: 2000 },
        });
        return (await j.waitUntilFinished(events)) as CapturePageResult;
      } catch (e) {
        // A job that exhausts retries rejects here; surface as a failed result so the
        // coordinator treats it like any other per-page failure (never aborts the run).
        return {
          route: job.route, pageSlug: job.pageSlug, status: "failed",
          error: e instanceof Error ? e.message : String(e),
          captureMs: 0, labelMs: 0, captureCached: false, labelSource: "heuristic-disabled",
        };
      }
    },
    async close() {
      await Promise.allSettled([queue.close(), events.close()]);
    },
  };
}
```

- [ ] **Step 4: Write `worker.ts` (consumer)**

```ts
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { runCapturePage, type CapturePageJob } from "../capture-job.ts";
import type { ArtifactStore } from "../store/index.ts";
import { CAPTURE_QUEUE_NAME } from "./bullmq.ts";

/** Start a BullMQ worker that consumes capture jobs. Run N replicas of this in
 *  prod; each processes `concurrency` jobs at once. The store MUST be shared (S3). */
export function startCaptureWorker(opts: {
  redisUrl: string; store: ArtifactStore; scratchRoot: string; concurrency: number;
}): Worker {
  const connection = new IORedis(opts.redisUrl, { maxRetriesPerRequest: null });
  return new Worker(
    CAPTURE_QUEUE_NAME,
    async (job) => runCapturePage(job.data as CapturePageJob, opts.store, opts.scratchRoot),
    { connection, concurrency: opts.concurrency },
  );
}
```

- [ ] **Step 5: Run to verify it passes** (with Redis up)

Run: `docker compose up -d && cd packages/clone-engine && pnpm exec vitest run test/queue-bullmq.test.ts`
Expected: PASS when Redis up; skipped otherwise.

- [ ] **Step 6: Commit**

```bash
git add packages/clone-engine/src/queue/bullmq.ts packages/clone-engine/src/queue/worker.ts packages/clone-engine/test/queue-bullmq.test.ts
git commit -m "feat(engine): bullmqCaptureQueue producer + capture worker"
```

---

## Task 5: `captureQueueFromEnv` factory + barrel

**Files:**
- Create: `packages/clone-engine/src/queue/factory.ts`
- Create: `packages/clone-engine/src/queue/index.ts`

- [ ] **Step 1: Write `factory.ts`**

```ts
import type { ArtifactStore } from "../store/index.ts";
import type { CaptureQueue } from "./types.ts";
import { localCaptureQueue } from "./local.ts";
import { bullmqCaptureQueue } from "./bullmq.ts";

/**
 * Pick the capture queue from env. `CAPTURE_QUEUE=bullmq` → distributed (requires
 * REDIS_URL and a shared store); anything else → in-process. Guards against the
 * footgun of distributed mode with a non-shared store.
 */
export function captureQueueFromEnv(opts: {
  store: ArtifactStore; scratchRoot: string; env?: Record<string, string | undefined>;
}): CaptureQueue {
  const env = opts.env ?? process.env;
  if (env.CAPTURE_QUEUE === "bullmq") {
    if ((env.ARTIFACT_STORE ?? "fs") !== "s3") {
      throw new Error("CAPTURE_QUEUE=bullmq requires ARTIFACT_STORE=s3 (workers need a shared store)");
    }
    const redisUrl = env.REDIS_URL;
    if (!redisUrl) throw new Error("CAPTURE_QUEUE=bullmq requires REDIS_URL");
    return bullmqCaptureQueue({ redisUrl });
  }
  return localCaptureQueue(opts.store, opts.scratchRoot);
}
```

- [ ] **Step 2: Write `index.ts`**

```ts
export type { CaptureQueue } from "./types.ts";
export { localCaptureQueue } from "./local.ts";
export { bullmqCaptureQueue, CAPTURE_QUEUE_NAME } from "./bullmq.ts";
export { startCaptureWorker } from "./worker.ts";
export { captureQueueFromEnv } from "./factory.ts";
export type { CapturePageJob, CapturePageResult } from "../capture-job.ts";
export { runCapturePage } from "../capture-job.ts";
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd packages/clone-engine && pnpm typecheck`

```bash
git add packages/clone-engine/src/queue/factory.ts packages/clone-engine/src/queue/index.ts
git commit -m "feat(engine): captureQueueFromEnv factory + queue barrel"
```

---

## Task 6: coordinator uses the queue

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts`

- [ ] **Step 1: Add a `queue` option to `BuildSiteOpts`**

```ts
  /** Capture queue. Defaults to captureQueueFromEnv() (local unless CAPTURE_QUEUE=bullmq). */
  queue?: CaptureQueue;
```

Imports:

```ts
import { captureQueueFromEnv, type CaptureQueue } from "./queue/index.ts";
import type { CapturePageJob } from "./capture-job.ts";
```

- [ ] **Step 2: Rewrite `capturePhase` to call the queue** (replaces the inline capture+label body from Plan 2)

```ts
async function capturePhase(ctx: {
  pages: AugmentedPage[]; runId: string; concurrency: number; runLlm: boolean;
  queue: CaptureQueue; queueMode: "local" | "bullmq"; emit: ReturnType<typeof makeEmit>;
}): Promise<CaptureOutcome[]> {
  const { pages, runId, concurrency, runLlm, queue, queueMode, emit } = ctx;
  // Local: coordinator bounds concurrency. BullMQ: enqueue all; the fleet bounds it.
  const width = queueMode === "bullmq" ? pages.length : concurrency;
  return mapPool(pages, Math.max(1, width), async (p) => {
    const job: CapturePageJob = { runId, route: p.route, url: p.url, dir: p.dir, pageSlug: p.out, llm: runLlm };
    emit({ type: "page.capture.started", route: p.route });
    const r = await queue.capturePage(job);
    if (r.status === "failed") emit({ type: "page.failed", route: p.route, error: (r.error ?? "capture failed").split("\n")[0] });
    else emit({ type: "page.capture.done", route: p.route });
    return {
      page: p, status: r.status, error: r.error,
      captureMs: r.captureMs, labelMs: r.labelMs, captureCached: r.captureCached,
      freshCaptureMs: r.freshCaptureMs, labelSource: r.labelSource, labelFallbackReason: r.labelFallbackReason,
      labels: null, // labels live in labels.json in the store; report reads them from disk post-build
    };
  });
}
```

- [ ] **Step 3: Construct the queue in `buildSite` and pass it through; close it in a `finally`**

In `buildSite`, after resolving `store`/`runId`/`concurrency`:

```ts
  const scratchRoot = cwd;
  const queueMode: "local" | "bullmq" = (process.env.CAPTURE_QUEUE === "bullmq") ? "bullmq" : "local";
  const queue = opts.queue ?? captureQueueFromEnv({ store, scratchRoot });
  try {
    const captured = await capturePhase({ pages: augmented, runId, concurrency, runLlm, queue, queueMode, emit });
    // … barrier, buildPhase, assemble, report (unchanged from Plan 2) …
    return { ok, failed };
  } finally {
    await queue.close();
  }
```

- [ ] **Step 4: Report — read `unknownSections` from `labels.json` on disk**

In the report merge (Plan 2 Task 4 Step 5), replace `const unknownSections = c.labels ? … : 0;` with a disk read (labels.json is present in `scratch` after `buildPhase` pulled the page):

```ts
      let unknownSections = 0;
      try {
        const lbls = JSON.parse(fs.readFileSync(path.join(scratch, "labels.json"), "utf8")) as { sections: { role: string }[] };
        unknownSections = lbls.sections.filter((s) => s.role === "unknown").length;
      } catch { /* no labels for a failed page */ }
```

- [ ] **Step 5: Full suite (Redis + MinIO up)**

Run: `docker compose up -d && cd packages/clone-engine && pnpm test`
Expected: all pass. Local default path (in-process) unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/clone-engine/src/orchestrate.ts
git commit -m "feat(engine): coordinator drives capture through the CaptureQueue seam"
```

---

## Task 7: CLI `worker` subcommand + `--queue` flag

**Files:**
- Modify: `packages/clone-engine/src/cli.ts`

- [ ] **Step 1: Add a `worker` subcommand**

```ts
  case "worker": {
    // node src/cli.ts worker   (long-running; SERVICE=capture-worker in prod)
    const { startCaptureWorker } = await import("./queue/index.ts");
    const { artifactStoreFromEnv } = await import("./store/index.ts");
    const { autoConcurrency } = await import("./concurrency.ts");
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) { console.error("worker requires REDIS_URL"); process.exit(1); }
    const store = artifactStoreFromEnv();
    const scratchRoot = process.env.CAPTURE_SCRATCH ?? path.join(process.cwd(), ".capture-scratch");
    const concurrency = autoConcurrency();
    console.log(`[worker] capture worker up — redis=${redisUrl} concurrency=${concurrency} store=${store.constructor.name}`);
    startCaptureWorker({ redisUrl, store, scratchRoot, concurrency });
    // keep process alive; BullMQ Worker holds the event loop.
    break;
  }
```

- [ ] **Step 2: Accept `--queue local|bullmq` on `build-auto`/`build-site`** (sets the env the factory reads, so behavior is identical to setting `CAPTURE_QUEUE`)

```ts
    const queueMode = arg("queue"); // "local" | "bullmq" | undefined
    if (queueMode) process.env.CAPTURE_QUEUE = queueMode;
```

Add `worker` to the `default` case's valid-subcommands message.

- [ ] **Step 3: Verify (local in-process default still works)**

Run: `node packages/clone-engine/src/cli.ts build-auto --site https://www.crossfitnewengland.com/ --out /tmp/cfne-local.html`
Expected: `store=FsArtifactStore`, local queue, completes.

- [ ] **Step 4: Verify distributed path locally (MinIO + Redis + 2 workers)**

```bash
docker compose up -d
export ARTIFACT_STORE=s3 S3_BUCKET=milo-artifacts S3_ENDPOINT=http://localhost:9000 \
       S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin AWS_REGION=us-east-1 \
       REDIS_URL=redis://localhost:6379
# terminal A + B (two workers):
node packages/clone-engine/src/cli.ts worker &
node packages/clone-engine/src/cli.ts worker &
# coordinator:
node packages/clone-engine/src/cli.ts build-auto --site https://www.crossfitnewengland.com/ --queue bullmq --out /tmp/cfne-dist.html
```
Expected: captures fan out across the two workers; `full-site/` assembles on the coordinator; fidelity matches the local run (never-regress).

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/cli.ts
git commit -m "feat(engine): CLI worker subcommand + --queue flag"
```

---

## Task 8: scaling runbook

**Files:**
- Create: `docs/clone-engine-scaling.md`

- [ ] **Step 1: Write the runbook** covering: env matrix (local in-process vs local-distributed vs prod); Railway (worker service with `replicas=N`, `CAPTURE_QUEUE=bullmq`, `ARTIFACT_STORE=s3`, managed Redis, object storage — note Railway volumes are single-attach so use an S3-compatible bucket, not a volume); EC2/Fargate (ASG or service replicas, EFS or S3, ElastiCache Redis); how `autoConcurrency()` sizes each worker; the throughput model (`wall ≈ ceil(pages / (replicas × perWorkerConcurrency)) × perPage + build_tail`); and the chromium-in-image requirement (`npx playwright install --with-deps chromium` in the worker Dockerfile).

- [ ] **Step 2: Commit**

```bash
git add docs/clone-engine-scaling.md
git commit -m "docs(engine): clone-engine horizontal scaling runbook"
```

---

## Self-Review

**Spec coverage:**
- Per-page capture as a distributable unit → Task 1 (`runCapturePage`). ✓
- One seam, in-process local / BullMQ prod, env-selected → Tasks 2/4/5. ✓
- Coordinator awaits barrier, then builds locally → Task 6. ✓
- Worker entrypoint + replicas → Tasks 4/7. ✓
- Shared-store enforcement in distributed mode → Task 5 factory guard. ✓
- Local behavior unchanged by default → Task 6 (`queueMode` defaults local), Task 7 Step 3. ✓
- Deployment guidance → Task 8. ✓

**Type consistency:** `CapturePageJob` fields (`runId`/`route`/`url`/`dir`/`pageSlug`/`llm`) are produced identically in Task 6 Step 2 and consumed in Task 1. `CapturePageResult` fields map 1:1 into `CaptureOutcome` in Task 6 Step 2. `CaptureQueue` (`capturePage`/`close`) is identical across `types.ts`, `local.ts`, `bullmq.ts`, and the factory. `CAPTURE_QUEUE_NAME` is shared by producer + worker.

**Cross-plan coherence check:**
- Plan 2's `capturePhase` per-page body → extracted verbatim into Plan 3 Task 1 `runCapturePage`; Plan 2's `mapPool` bounding is retained in the coordinator (Task 6 Step 2). No rework, only extraction. ✓
- Plan 2 dropped per-page LLM cost (aggregate only); Plan 3 doesn't reintroduce it. Consistent. ✓
- Plan 1's `ArtifactStore` is the shared substrate both workers and coordinator use; Plan 3 enforces `s3` for distribution. ✓

**Known revision points (revise between sections):**
1. `waitUntilFinished` holds a QueueEvents connection per queue instance — fine for one coordinator, but confirm it scales if a single process runs many concurrent builds. If not, switch to a FlowProducer parent/child (parent = build job) so the barrier is server-side.
2. Task 1 test seeds the cached path (no live browser). A fresh-capture worker test needs a served fixture page or a `captureFn` injection — decide with Plan 2's test-seam decision (keep them consistent).
3. `scratchRoot` on workers accumulates page dirs across jobs — add periodic cleanup (delete scratch after a successful `putDir`) if disk pressure shows up on long-lived workers.
