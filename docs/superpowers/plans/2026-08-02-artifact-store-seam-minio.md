> **STATUS: DEFERRED (2026-08-02).** Not needed for local + Railway parallelization. This is for later horizontal scale (multi-replica). The live plan is `2026-08-02-parallel-clone-local-and-railway.md`.

# ArtifactStore Seam + MinIO Parity — Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce one storage seam — `ArtifactStore` — with a local-filesystem adapter and an S3 adapter that talks to MinIO locally and real S3 in prod, so the capture→build pipeline uses an identical code path in every environment.

**Architecture:** A per-*directory* store boundary. `capture()` keeps writing per-page artifacts (`capture.json`, `labels.json`, `assets/`, screenshots) to a local scratch dir. The pipeline crosses the capture→build barrier by calling `store.putDir(pageKey, scratchDir)` and the build side calls `store.getDir(pageKey, scratchDir)`. `FsArtifactStore` makes those disk copies; `S3ArtifactStore` makes them S3/MinIO transfers. Backend is chosen by env var against one code path. This plan builds and tests the seam standalone — it does **not** rewire the pipeline (that is Plan 2).

**Tech Stack:** Node 24, TypeScript, `@aws-sdk/client-s3` (already a stack dep via `@milo/publish`), MinIO (S3-compatible, via docker-compose), Vitest.

**Parity principle:** `S3_ENDPOINT=http://localhost:9000` → MinIO (default local, offline, hermetic); `S3_ENDPOINT` unset → real AWS S3 (prod, or on-demand local smoke test). Same SDK calls in both.

---

## Roadmap (context — this plan is #1 of 3)

The full architecture is one thing with swappable adapters, delivered in three shippable layers:

- **Plan 1 (this doc): ArtifactStore seam + MinIO.** Storage parity foundation. Output-identical; no pipeline change yet. Ships the interface + adapters + local infra + tests.
- **Plan 2: Parallel phase-split pipeline.** Refactor `orchestrate.ts` into `discover → capture-all (bounded, container-aware auto-concurrency) → barrier → build/assemble-all`, crossing the barrier via `ArtifactStore.putDir/getDir`. Default `FsArtifactStore` → behavior-neutral locally. Ships the ~6–8× single-machine speedup.
- **Plan 3: Distributed BullMQ capture queue.** Promote per-page `capture()` to a queued job using an engine `JobQueue` seam (in-process workers locally / BullMQ `FlowProducer` parent+child in prod), mirroring the existing `apps/admin/src/jobs/queue.ts` pattern. Workers pull capture jobs; a parent job runs build/assemble after the child barrier. Scales horizontally across replicas → wall time flat in page count.

Each layer depends only on the one before it. Plan 2 & 3 will be written in full once Plan 1's interfaces are concrete (avoids placeholder/type drift).

---

## File Structure

- `docker-compose.yml` (root, **create**) — MinIO + Redis for local dev/parity. Redis is unused until Plan 3 but belongs in the same compose file.
- `packages/clone-engine/src/store/types.ts` (**create**) — the `ArtifactStore` interface.
- `packages/clone-engine/src/store/fs-store.ts` (**create**) — `FsArtifactStore`, backed by a local root dir.
- `packages/clone-engine/src/store/s3-store.ts` (**create**) — `S3ArtifactStore`, MinIO/AWS via one `S3Client`.
- `packages/clone-engine/src/store/factory.ts` (**create**) — `artifactStoreFromEnv()` picks the backend.
- `packages/clone-engine/src/store/index.ts` (**create**) — barrel re-export.
- `packages/clone-engine/package.json` (**modify**) — add `@aws-sdk/client-s3` dependency + `./store` export.
- `packages/clone-engine/test/store/fs-store.test.ts` (**create**) — Fs adapter unit tests.
- `packages/clone-engine/test/store/s3-store.test.ts` (**create**) — S3 adapter integration tests vs MinIO (skipped when MinIO is absent).
- `.env.example` (root, **modify or create**) — document the store env vars.

---

## Task 1: MinIO + Redis local infra

**Files:**
- Create: `docker-compose.yml`
- Modify/Create: `.env.example`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
# Local backing services for dev/prod parity.
# Bring up with:  docker compose up -d
#   MinIO  → S3-compatible object store (artifact store parity with prod S3)
#   Redis  → BullMQ backend (used from Plan 3 onward; here for parity)
services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000" # S3 API
      - "9001:9001" # web console
    volumes:
      - milo-minio:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7
    ports:
      - "6379:6379"

volumes:
  milo-minio:
```

- [ ] **Step 2: Document env vars in `.env.example`**

Append (create the file if absent):

```bash
# --- Artifact store (Plan 1) ---
# "fs" (default, local disk) or "s3" (MinIO locally / AWS S3 in prod)
ARTIFACT_STORE=fs
# fs backend root (relative to cwd or absolute)
ARTIFACT_DIR=.artifacts
# s3 backend
S3_BUCKET=milo-artifacts
S3_ENDPOINT=http://localhost:9000   # MinIO locally; leave UNSET for real AWS S3
S3_ACCESS_KEY=minioadmin            # MinIO default; ignored when S3_ENDPOINT is unset (uses AWS profile)
S3_SECRET_KEY=minioadmin
AWS_REGION=us-east-1
```

- [ ] **Step 3: Verify MinIO comes up**

Run: `docker compose up -d && sleep 3 && curl -s -o /dev/null -w "%{http_code}" http://localhost:9000/minio/health/live`
Expected: `200`

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore(infra): local MinIO + Redis for dev/prod storage parity"
```

---

## Task 2: `ArtifactStore` interface

**Files:**
- Create: `packages/clone-engine/src/store/types.ts`

- [ ] **Step 1: Write the interface**

```ts
/**
 * Storage seam for the capture→build pipeline. One code path, two backends
 * (local filesystem, S3/MinIO). The unit is a per-page directory, crossed at
 * the capture→build barrier via putDir/getDir. JSON helpers exist for small
 * coordination docs (e.g. a manifest of captured pages).
 *
 * Keys are POSIX-style, "/"-separated, no leading slash (e.g. "sites/abc/pages/home").
 */
export interface ArtifactStore {
  /** Upload every file under `localDir` (recursive) to keys under `${prefix}/…`. */
  putDir(prefix: string, localDir: string): Promise<void>;
  /** Download every object under `${prefix}/…` into `localDir`, recreating structure. */
  getDir(prefix: string, localDir: string): Promise<void>;
  /** Write a JSON value at `key`. */
  putJson(key: string, value: unknown): Promise<void>;
  /** Read + parse the JSON value at `key`, or `null` if it does not exist. */
  getJson<T>(key: string): Promise<T | null>;
  /** True if at least one object exists under `prefix`. */
  exists(prefix: string): Promise<boolean>;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/clone-engine/src/store/types.ts
git commit -m "feat(engine): ArtifactStore interface (storage seam)"
```

---

## Task 3: `FsArtifactStore` (local filesystem adapter)

**Files:**
- Create: `packages/clone-engine/src/store/fs-store.ts`
- Test: `packages/clone-engine/test/store/fs-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsArtifactStore } from "../../src/store/fs-store.ts";

describe("FsArtifactStore", () => {
  let root: string;
  let scratch: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "milo-store-"));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "milo-scratch-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("round-trips a directory (putDir → getDir)", async () => {
    // arrange: a page dir with nested files
    fs.writeFileSync(path.join(scratch, "capture.json"), '{"ok":true}');
    fs.mkdirSync(path.join(scratch, "assets"));
    fs.writeFileSync(path.join(scratch, "assets", "a0.png"), Buffer.from([1, 2, 3]));

    const store = new FsArtifactStore(root);
    await store.putDir("sites/abc/pages/home", scratch);

    const out = fs.mkdtempSync(path.join(os.tmpdir(), "milo-out-"));
    await store.getDir("sites/abc/pages/home", out);

    expect(fs.readFileSync(path.join(out, "capture.json"), "utf8")).toBe('{"ok":true}');
    expect([...fs.readFileSync(path.join(out, "assets", "a0.png"))]).toEqual([1, 2, 3]);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("putJson/getJson round-trip; getJson returns null for a missing key", async () => {
    const store = new FsArtifactStore(root);
    expect(await store.getJson("sites/abc/manifest.json")).toBeNull();
    await store.putJson("sites/abc/manifest.json", { pages: ["home"] });
    expect(await store.getJson("sites/abc/manifest.json")).toEqual({ pages: ["home"] });
  });

  it("exists reflects whether a prefix has any object", async () => {
    const store = new FsArtifactStore(root);
    expect(await store.exists("sites/abc/pages/home")).toBe(false);
    fs.writeFileSync(path.join(scratch, "capture.json"), "{}");
    await store.putDir("sites/abc/pages/home", scratch);
    expect(await store.exists("sites/abc/pages/home")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/store/fs-store.test.ts`
Expected: FAIL — cannot resolve `../../src/store/fs-store.ts`.

- [ ] **Step 3: Write the implementation**

```ts
import fs from "node:fs";
import path from "node:path";
import type { ArtifactStore } from "./types.ts";

/** Filesystem-backed ArtifactStore. Keys map to paths under `root`. */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    // Keys are POSIX; on Windows path.join still yields a valid local path.
    return path.join(this.root, ...key.split("/"));
  }

  async putDir(prefix: string, localDir: string): Promise<void> {
    const dest = this.abs(prefix);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(localDir, dest, { recursive: true });
  }

  async getDir(prefix: string, localDir: string): Promise<void> {
    const src = this.abs(prefix);
    fs.mkdirSync(localDir, { recursive: true });
    fs.cpSync(src, localDir, { recursive: true });
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const dest = this.abs(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(value, null, 2));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const src = this.abs(key);
    if (!fs.existsSync(src)) return null;
    return JSON.parse(fs.readFileSync(src, "utf8")) as T;
  }

  async exists(prefix: string): Promise<boolean> {
    return fs.existsSync(this.abs(prefix));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/clone-engine && pnpm exec vitest run test/store/fs-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/store/fs-store.ts packages/clone-engine/test/store/fs-store.test.ts
git commit -m "feat(engine): FsArtifactStore (local-disk adapter) + tests"
```

---

## Task 4: add `@aws-sdk/client-s3` dependency + `./store` export

**Files:**
- Modify: `packages/clone-engine/package.json`

- [ ] **Step 1: Add the dependency and export**

In `packages/clone-engine/package.json`, add to `exports`:

```json
    "./store": "./src/store/index.ts"
```

and to `dependencies` (match the version range used by `@milo/publish`):

```json
    "@aws-sdk/client-s3": "^3.0.0"
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: lockfile updates; `@aws-sdk/client-s3` resolved for `@milo/clone-engine`.

- [ ] **Step 3: Commit**

```bash
git add packages/clone-engine/package.json pnpm-lock.yaml
git commit -m "chore(engine): add @aws-sdk/client-s3 dep + ./store export"
```

---

## Task 5: `S3ArtifactStore` (MinIO/AWS adapter)

**Files:**
- Create: `packages/clone-engine/src/store/s3-store.ts`
- Test: `packages/clone-engine/test/store/s3-store.test.ts`

- [ ] **Step 1: Write the failing integration test (skipped without MinIO)**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { S3ArtifactStore } from "../../src/store/s3-store.ts";

// Integration test against a local MinIO (docker compose up -d).
// Skips automatically when MinIO is unreachable so `pnpm test` stays hermetic in CI.
const ENDPOINT = process.env.S3_ENDPOINT ?? "http://localhost:9000";
async function minioUp(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("S3ArtifactStore (MinIO)", async () => {
  const up = await minioUp();
  const bucket = "milo-artifacts-test";

  beforeAll(async () => {
    if (!up) return;
    // ensureBucket is idempotent — safe to call before each run.
    await new S3ArtifactStore({
      bucket, endpoint: ENDPOINT, accessKey: "minioadmin", secretKey: "minioadmin", region: "us-east-1",
    }).ensureBucket();
  });

  it.skipIf(!up)("round-trips a directory and json", async () => {
    const store = new S3ArtifactStore({
      bucket, endpoint: ENDPOINT, accessKey: "minioadmin", secretKey: "minioadmin", region: "us-east-1",
    });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "milo-s3-"));
    fs.writeFileSync(path.join(scratch, "capture.json"), '{"ok":true}');
    fs.mkdirSync(path.join(scratch, "assets"));
    fs.writeFileSync(path.join(scratch, "assets", "a0.png"), Buffer.from([1, 2, 3]));

    const key = `run-${process.pid}/home`;
    expect(await store.exists(key)).toBe(false);
    await store.putDir(key, scratch);
    expect(await store.exists(key)).toBe(true);

    const out = fs.mkdtempSync(path.join(os.tmpdir(), "milo-s3-out-"));
    await store.getDir(key, out);
    expect(fs.readFileSync(path.join(out, "capture.json"), "utf8")).toBe('{"ok":true}');
    expect([...fs.readFileSync(path.join(out, "assets", "a0.png"))]).toEqual([1, 2, 3]);

    await store.putJson(`run-${process.pid}/manifest.json`, { pages: ["home"] });
    expect(await store.getJson(`run-${process.pid}/manifest.json`)).toEqual({ pages: ["home"] });

    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/store/s3-store.test.ts`
Expected: FAIL — cannot resolve `../../src/store/s3-store.ts`. (If MinIO is down, the single case is skipped, but the import error still fails collection — which is the failure we want to see.)

- [ ] **Step 3: Write the implementation**

```ts
import fs from "node:fs";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import type { ArtifactStore } from "./types.ts";

export interface S3ArtifactStoreOpts {
  bucket: string;
  region: string;
  /** MinIO/localstack endpoint, e.g. http://localhost:9000. Omit for real AWS S3. */
  endpoint?: string;
  /** Static creds (MinIO). When omitted with no endpoint, the SDK's default chain applies. */
  accessKey?: string;
  secretKey?: string;
}

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".json": "application/json", ".html": "text/html", ".css": "text/css",
    ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  };
  return map[ext] ?? "application/octet-stream";
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? dir, e.name));
}

/** S3-backed ArtifactStore. Path-style + static creds when `endpoint` is set (MinIO). */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3ArtifactStoreOpts) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: Boolean(opts.endpoint), // MinIO requires path-style addressing
      credentials:
        opts.accessKey && opts.secretKey
          ? { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey }
          : undefined, // real AWS → default provider chain
    });
  }

  /** Create the bucket if it does not exist (MinIO/dev convenience; no-op if present). */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })).catch(() => {});
    }
  }

  async putDir(prefix: string, localDir: string): Promise<void> {
    const files = walk(localDir);
    await Promise.all(files.map(async (file) => {
      const rel = path.relative(localDir, file).split(path.sep).join("/");
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${prefix}/${rel}`,
        Body: fs.readFileSync(file),
        ContentType: contentTypeFor(file),
      }));
    }));
  }

  async getDir(prefix: string, localDir: string): Promise<void> {
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: `${prefix}/`, ContinuationToken: token,
      }));
      await Promise.all((res.Contents ?? []).map(async (obj) => {
        if (!obj.Key) return;
        const rel = obj.Key.slice(`${prefix}/`.length);
        const dest = path.join(localDir, ...rel.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const got = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: obj.Key }));
        const bytes = await got.Body!.transformToByteArray();
        fs.writeFileSync(dest, Buffer.from(bytes));
      }));
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key,
      Body: JSON.stringify(value, null, 2), ContentType: "application/json",
    }));
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = await res.Body?.transformToString();
      return body ? (JSON.parse(body) as T) : null;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async exists(prefix: string): Promise<boolean> {
    const res = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket, Prefix: `${prefix}/`, MaxKeys: 1,
    }));
    return (res.KeyCount ?? 0) > 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose up -d && cd packages/clone-engine && pnpm exec vitest run test/store/s3-store.test.ts`
Expected: PASS (1 test) when MinIO is up. Without MinIO: the case is skipped and the file passes with 0 assertions (still green).

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/store/s3-store.ts packages/clone-engine/test/store/s3-store.test.ts
git commit -m "feat(engine): S3ArtifactStore (MinIO/AWS adapter) + integration test"
```

---

## Task 6: `artifactStoreFromEnv()` factory + barrel

**Files:**
- Create: `packages/clone-engine/src/store/factory.ts`
- Create: `packages/clone-engine/src/store/index.ts`
- Test: append to `packages/clone-engine/test/store/fs-store.test.ts`

- [ ] **Step 1: Write the failing test (append to fs-store.test.ts)**

```ts
import { artifactStoreFromEnv } from "../../src/store/factory.ts";
import { FsArtifactStore } from "../../src/store/fs-store.ts";
import { S3ArtifactStore } from "../../src/store/s3-store.ts";

describe("artifactStoreFromEnv", () => {
  it("defaults to FsArtifactStore", () => {
    const store = artifactStoreFromEnv({});
    expect(store).toBeInstanceOf(FsArtifactStore);
  });
  it("returns S3ArtifactStore when ARTIFACT_STORE=s3", () => {
    const store = artifactStoreFromEnv({
      ARTIFACT_STORE: "s3", S3_BUCKET: "b", S3_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY: "minioadmin", S3_SECRET_KEY: "minioadmin", AWS_REGION: "us-east-1",
    });
    expect(store).toBeInstanceOf(S3ArtifactStore);
  });
  it("throws a clear error when s3 is selected without a bucket", () => {
    expect(() => artifactStoreFromEnv({ ARTIFACT_STORE: "s3" }))
      .toThrow(/S3_BUCKET is required/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/clone-engine && pnpm exec vitest run test/store/fs-store.test.ts`
Expected: FAIL — cannot resolve `../../src/store/factory.ts`.

- [ ] **Step 3: Write the factory + barrel**

`factory.ts`:

```ts
import { FsArtifactStore } from "./fs-store.ts";
import { S3ArtifactStore } from "./s3-store.ts";
import type { ArtifactStore } from "./types.ts";

/**
 * Build an ArtifactStore from an env bag (defaults to process.env). One code
 * path; `ARTIFACT_STORE` picks the backend. `S3_ENDPOINT` set → MinIO
 * (path-style + static creds); unset → real AWS S3 (default cred chain).
 */
export function artifactStoreFromEnv(env: Record<string, string | undefined> = process.env): ArtifactStore {
  if ((env.ARTIFACT_STORE ?? "fs") === "s3") {
    const bucket = env.S3_BUCKET;
    if (!bucket) throw new Error("artifactStoreFromEnv: S3_BUCKET is required when ARTIFACT_STORE=s3");
    return new S3ArtifactStore({
      bucket,
      region: env.AWS_REGION ?? "us-east-1",
      endpoint: env.S3_ENDPOINT,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    });
  }
  return new FsArtifactStore(env.ARTIFACT_DIR ?? ".artifacts");
}
```

`index.ts`:

```ts
export type { ArtifactStore } from "./types.ts";
export { FsArtifactStore } from "./fs-store.ts";
export { S3ArtifactStore } from "./s3-store.ts";
export type { S3ArtifactStoreOpts } from "./s3-store.ts";
export { artifactStoreFromEnv } from "./factory.ts";
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/clone-engine && pnpm exec vitest run test/store/fs-store.test.ts`
Expected: PASS (6 tests total: 3 Fs + 3 factory).

- [ ] **Step 5: Typecheck the package**

Run: `cd packages/clone-engine && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/clone-engine/src/store/factory.ts packages/clone-engine/src/store/index.ts packages/clone-engine/test/store/fs-store.test.ts
git commit -m "feat(engine): artifactStoreFromEnv factory + store barrel"
```

---

## Task 7: Full package test + typecheck gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full engine test suite**

Run: `cd packages/clone-engine && pnpm test`
Expected: all existing tests + the new store tests pass (S3 case skipped if MinIO down).

- [ ] **Step 2: Run with MinIO up to exercise the S3 path**

Run: `docker compose up -d && cd packages/clone-engine && pnpm test`
Expected: S3ArtifactStore integration test PASSES (not skipped).

- [ ] **Step 3: Confirm no other package broke**

Run: `pnpm -r typecheck` (or `pnpm -r test` if time allows)
Expected: green.

---

## Self-Review

**Spec coverage:**
- One storage seam, two backends, env-selected → Tasks 2/3/5/6. ✓
- MinIO local / real S3 prod via `S3_ENDPOINT` → Task 5 (`endpoint`/`forcePathStyle`) + Task 6 factory. ✓
- Per-directory boundary (putDir/getDir) → Tasks 2/3/5. ✓
- Local infra for parity → Task 1 (docker-compose: MinIO + Redis). ✓
- Hermetic tests (no network required by default) → Task 5 `it.skipIf(!up)`. ✓
- Reuses existing stack S3 dep/pattern → Task 4 (`@aws-sdk/client-s3`, same range as `@milo/publish`). ✓
- Does NOT rewire the pipeline (deferred to Plan 2) → stated in Architecture. ✓

**Type consistency:** `ArtifactStore` methods (`putDir`, `getDir`, `putJson`, `getJson<T>`, `exists`) are identical across `types.ts`, `fs-store.ts`, `s3-store.ts`, and the factory return type. `S3ArtifactStoreOpts` fields (`bucket`, `region`, `endpoint`, `accessKey`, `secretKey`) match between the class and the tests. ✓

**Placeholder scan:** every code step contains full implementation or full test code; no TBD/TODO/"handle edge cases". ✓
