# Docs Storage Plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all `milo learn` doc output through a shared `@milo/storage` seam (local disk or S3/MinIO), add a logger seam with `--verbose`, and add `milo clone --deploy`.

**Architecture:** The `StorageAdapter` seam moves from `packages/clone-engine/src/storage/` to a new `@milo/storage` package. `runLearn` gains `storage`/`slug`/`logger` options and writes every doc through a `DocStore` helper keyed at `gyms/<slug>/docs/`; `--out <dir>` keeps working as a `LocalFsAdapter` rooted at that dir with no prefix. The CLI's `learn` command defaults to storage mode and gains `--verbose`; `clone` gains an opt-in `--deploy` that publishes `full-site/` to staging after a successful build.

**Tech Stack:** TypeScript, Zod, AWS SDK S3, Vitest — all already in use.

**Spec:** `docs/superpowers/specs/2026-08-03-docs-storage-plumbing-design.md`

**Clone safety rule:** clone-engine internals stay behavior-identical — only import paths change (Task 1). The engine ENOENT papercuts are a separate task, not this plan.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `packages/storage/package.json` | **CREATE** | `@milo/storage` package manifest |
| `packages/storage/tsconfig.json` | **CREATE** | copied from `@milo/intake` |
| `packages/storage/src/adapter.ts` | **MOVE** (from clone-engine) | `StorageAdapter` interface |
| `packages/storage/src/local.ts` | **MOVE + edit** | `LocalFsAdapter` + expose `root` |
| `packages/storage/src/s3.ts` | **MOVE + edit** | `S3Adapter` + expose `bucket` |
| `packages/storage/src/index.ts` | **CREATE** (replaces moved one) | `getStorage()` factory, `slugFromUrl`, `describeStorage` |
| `packages/storage/test/storage.test.ts` | **MOVE + edit** | adapter tests + new factory/slug/describe tests |
| `packages/clone-engine/src/storage/capture-cache.ts` | **MODIFY** | import adapter from `@milo/storage` |
| `packages/clone-engine/src/orchestrate.ts` | **MODIFY** (line 33) | import `getStorage` from `@milo/storage` |
| `packages/clone-engine/test/capture-cache.test.ts` | **MODIFY** (line 10) | import `LocalFsAdapter` from `@milo/storage` |
| `packages/clone-engine/package.json` | **MODIFY** | drop `@aws-sdk/client-s3`, add `@milo/storage` |
| `packages/schema/src/jobs.ts` | **MODIFY** | `LearnJob.verbose`, `CloneJob.deploy` |
| `packages/schema/test/jobs.test.ts` | **CREATE** | schema default tests |
| `packages/intake/src/logger.ts` | **CREATE** | `MiloLogger`, `consoleLogger`, `verboseConsoleLogger` |
| `packages/intake/src/doc-store.ts` | **CREATE** | `DocStore` + `resolveDocStore` |
| `packages/intake/src/intake.ts` | **MODIFY** | storage-backed writes, logger, `docsUri` |
| `packages/intake/src/index.ts` | **MODIFY** | export logger |
| `packages/intake/package.json` | **MODIFY** | add `@milo/storage` dep |
| `packages/intake/test/intake.test.ts` | **MODIFY** | storage-mode + verbose tests |
| `apps/cli/src/milo.ts` | **MODIFY** | `learn --verbose` + storage default, `clone --deploy` |
| `apps/cli/package.json` | **MODIFY** | add `@milo/storage` dep |

**Not touched:** `packages/clone-engine/src/orchestrate.ts` build logic, `apps/renderer/`, `packages/publish/`, `apps/admin/`.

---

## Task 1: Create `@milo/storage` and repoint clone-engine

**Files:**
- Create: `packages/storage/package.json`, `packages/storage/tsconfig.json`, `packages/storage/src/index.ts`
- Move: `packages/clone-engine/src/storage/{adapter,local,s3}.ts` → `packages/storage/src/`
- Move: `packages/clone-engine/test/storage.test.ts` → `packages/storage/test/storage.test.ts`
- Modify: `packages/clone-engine/src/storage/capture-cache.ts`, `packages/clone-engine/src/orchestrate.ts`, `packages/clone-engine/test/capture-cache.test.ts`, `packages/clone-engine/package.json`

- [ ] **Step 1.1: Move the adapter files**

```bash
cd /Users/dan/pushpress/milo-ev2
mkdir -p packages/storage/src packages/storage/test
git mv packages/clone-engine/src/storage/adapter.ts packages/storage/src/adapter.ts
git mv packages/clone-engine/src/storage/local.ts packages/storage/src/local.ts
git mv packages/clone-engine/src/storage/s3.ts packages/storage/src/s3.ts
git mv packages/clone-engine/test/storage.test.ts packages/storage/test/storage.test.ts
git rm packages/clone-engine/src/storage/index.ts
```

- [ ] **Step 1.2: Create the package manifest**

Write `packages/storage/package.json`:

```json
{
  "name": "@milo/storage",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./adapter": "./src/adapter.ts",
    "./local": "./src/local.ts",
    "./s3": "./src/s3.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.1092.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

```bash
cp packages/intake/tsconfig.json packages/storage/tsconfig.json
```

- [ ] **Step 1.3: Expose `root` on LocalFsAdapter and `bucket` on S3Adapter**

In `packages/storage/src/local.ts`, add this getter immediately after the constructor:

```typescript
  /** Absolute root dir — used by describeStorage. */
  get root(): string {
    return this.resolvedRoot;
  }
```

In `packages/storage/src/s3.ts`, change the field declaration from `private readonly bucket: string;` to `readonly bucket: string;` (public — used by describeStorage).

- [ ] **Step 1.4: Write the new factory index**

Write `packages/storage/src/index.ts`:

```typescript
/**
 * Storage factory. S3 when STORAGE_BUCKET is configured (production, or MinIO
 * via STORAGE_ENDPOINT for local dev); otherwise local disk so dev and tests
 * run the same code path with zero infra.
 *
 * Env vars:
 *   STORAGE_BUCKET    — S3 bucket; presence selects the S3 backend
 *   STORAGE_ENDPOINT  — optional custom endpoint (MinIO: http://localhost:9000)
 *   STORAGE_KEY       — access key (omit to use the AWS default credential chain)
 *   STORAGE_SECRET    — secret key
 *   STORAGE_REGION    — optional, defaults to us-east-1
 *   MILO_STORAGE_DIR  — local backend root override
 *   CAPTURE_CACHE_DIR — deprecated alias for MILO_STORAGE_DIR
 */
import os from "node:os";
import path from "node:path";
import type { StorageAdapter } from "./adapter.ts";
import { LocalFsAdapter } from "./local.ts";
import { S3Adapter } from "./s3.ts";

export type { StorageAdapter } from "./adapter.ts";
export { LocalFsAdapter } from "./local.ts";
export { S3Adapter } from "./s3.ts";
export type { S3AdapterOpts } from "./s3.ts";

export function getStorage(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  if (env.STORAGE_BUCKET) {
    return new S3Adapter({
      bucket: env.STORAGE_BUCKET,
      region: env.STORAGE_REGION,
      endpoint: env.STORAGE_ENDPOINT,
      accessKeyId: env.STORAGE_KEY,
      secretAccessKey: env.STORAGE_SECRET,
    });
  }
  const root = env.MILO_STORAGE_DIR ?? env.CAPTURE_CACHE_DIR ?? path.join(os.homedir(), ".milo");
  return new LocalFsAdapter(root);
}

/** Stable per-site slug derived from a URL: hostname, lowercase, no leading www., dots→dashes. */
export function slugFromUrl(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return host.replace(/\./g, "-");
}

/** Human-readable URI prefix for a backend, e.g. file:///Users/x/.milo or s3://bucket. */
export function describeStorage(storage: StorageAdapter): string {
  if (storage instanceof LocalFsAdapter) return `file://${storage.root}`;
  if (storage instanceof S3Adapter) return `s3://${storage.bucket}`;
  return "custom";
}
```

- [ ] **Step 1.5: Fix moved test imports and extend factory tests**

In `packages/storage/test/storage.test.ts`, replace these four import lines:

```typescript
import type { StorageAdapter } from "../src/storage/adapter.ts";
import { LocalFsAdapter } from "../src/storage/local.ts";
import { S3Adapter } from "../src/storage/s3.ts";
import { getStorage } from "../src/storage/index.ts";
```

with:

```typescript
import type { StorageAdapter } from "../src/adapter.ts";
import { LocalFsAdapter } from "../src/local.ts";
import { S3Adapter } from "../src/s3.ts";
import { getStorage, slugFromUrl, describeStorage } from "../src/index.ts";
```

In the existing `describe("getStorage factory", ...)` block, find the test asserting the default local root (it expects a path under `os.tmpdir()` / `milo-storage`). Change the expected path to `path.join(os.homedir(), ".milo")`.

Then append these two describe blocks at the end of the file:

```typescript
describe("slugFromUrl", () => {
  it("derives stable slugs from URLs", () => {
    expect(slugFromUrl("https://speakeasyofstrength.com")).toBe("speakeasyofstrength-com");
    expect(slugFromUrl("https://www.Example-Gym.co.uk/path?q=1")).toBe("example-gym-co-uk");
  });
});

describe("describeStorage", () => {
  it("describes local and s3 backends as URIs", () => {
    expect(describeStorage(new LocalFsAdapter("/tmp/milo-x"))).toBe("file:///tmp/milo-x");
    // No network: constructing S3Adapter without a client never sends a request.
    expect(describeStorage(new S3Adapter({ bucket: "my-bucket" }))).toBe("s3://my-bucket");
  });
});
```

- [ ] **Step 1.6: Repoint clone-engine imports**

In `packages/clone-engine/src/storage/capture-cache.ts`, replace:

```typescript
import type { StorageAdapter } from "./adapter.ts";
```

with:

```typescript
import type { StorageAdapter } from "@milo/storage";
```

In `packages/clone-engine/src/orchestrate.ts` (line 33), replace:

```typescript
import { getStorage, type StorageAdapter } from "./storage/index.ts";
```

with:

```typescript
import { getStorage, type StorageAdapter } from "@milo/storage";
```

(Line 34 — the `capture-cache.ts` import — stays as-is.)

In `packages/clone-engine/test/capture-cache.test.ts`, replace:

```typescript
import { LocalFsAdapter } from "../src/storage/local.ts";
```

with:

```typescript
import { LocalFsAdapter } from "@milo/storage";
```

In `packages/clone-engine/package.json`: remove the `"@aws-sdk/client-s3": "^3.1092.0"` dependency (only the moved `s3.ts` used it — verified) and add `"@milo/storage": "workspace:*"` to `dependencies` (alphabetical, after `@milo/publish`).

- [ ] **Step 1.7: Install and run tests**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm install
pnpm --filter @milo/storage test 2>&1 | tail -8
pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism test/capture-cache.test.ts 2>&1 | tail -8
```

Expected: `@milo/storage` tests all pass (including the new `slugFromUrl`/`describeStorage` blocks); capture-cache tests pass against `@milo/storage`.

- [ ] **Step 1.8: Typecheck engine and run its full suite**

```bash
pnpm --filter @milo/clone-engine exec tsc --noEmit
pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism 2>&1 | tail -6
```

Expected: no type errors; full engine suite green.

- [ ] **Step 1.9: Commit**

```bash
git add packages/storage packages/clone-engine
git commit -m "feat(storage): promote StorageAdapter seam to shared @milo/storage package

Local root default moves from os.tmpdir()/milo-storage to ~/.milo
(MILO_STORAGE_DIR override; CAPTURE_CACHE_DIR kept as deprecated alias).
Adds slugFromUrl + describeStorage. Clone-engine behavior unchanged —
imports only."
```

---

## Task 2: Add `verbose` to LearnJob, `deploy` to CloneJob

**Files:**
- Modify: `packages/schema/src/jobs.ts`
- Create: `packages/schema/test/jobs.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `packages/schema/test/jobs.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CloneJob, LearnJob } from "../src/jobs.ts";

describe("job schemas", () => {
  it("CloneJob defaults deploy to false", () => {
    expect(CloneJob.parse({ type: "clone", url: "https://example.com" }).deploy).toBe(false);
  });

  it("CloneJob accepts deploy: true", () => {
    expect(CloneJob.parse({ type: "clone", url: "https://example.com", deploy: true }).deploy).toBe(true);
  });

  it("LearnJob defaults verbose to false", () => {
    expect(LearnJob.parse({ type: "learn", url: "https://example.com" }).verbose).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run to confirm failure**

```bash
pnpm --filter @milo/schema exec vitest run test/jobs.test.ts 2>&1 | tail -6
```

Expected: FAIL — `.deploy` / `.verbose` are `undefined`, not `false`.

- [ ] **Step 2.3: Add the fields**

In `packages/schema/src/jobs.ts`, add to `LearnJob`:

```typescript
export const LearnJob = z.object({
  type: z.literal("learn"),
  url: z.string().url(),
  verbose: z.boolean().default(false),
});
```

and add this line to `CloneJob` (after `concurrency`):

```typescript
  deploy: z.boolean().default(false),          // publish to staging after a successful build
```

- [ ] **Step 2.4: Run to confirm pass**

```bash
pnpm --filter @milo/schema exec vitest run test/jobs.test.ts 2>&1 | tail -4
```

Expected: 3 passed.

- [ ] **Step 2.5: Commit**

```bash
git add packages/schema/src/jobs.ts packages/schema/test/jobs.test.ts
git commit -m "feat(schema): add LearnJob.verbose and CloneJob.deploy"
```

---

## Task 3: Storage-backed `runLearn` with logger seam

This is the core task. All doc I/O in `runLearn`/`runIntake` routes through a new `DocStore` over `StorageAdapter`; every `console.*` in the learn path goes through `MiloLogger`.

**Files:**
- Create: `packages/intake/src/logger.ts`, `packages/intake/src/doc-store.ts`
- Modify: `packages/intake/src/intake.ts`, `packages/intake/src/index.ts`, `packages/intake/package.json`, `packages/intake/test/intake.test.ts`

- [ ] **Step 3.1: Create the logger**

Write `packages/intake/src/logger.ts`:

```typescript
/** Logger seam for learn — CLI passes console-backed loggers, admin can pass a structured emitter. */
export interface MiloLogger {
  info(msg: string): void;
  verbose(msg: string): void;
  warn(msg: string): void;
}

/** Default: milestones + warnings to console, verbose suppressed. */
export const consoleLogger: MiloLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  verbose: () => {},
};

/** Console logger with verbose lines enabled (CLI --verbose). */
export function verboseConsoleLogger(): MiloLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    verbose: (m) => console.log(m),
  };
}
```

- [ ] **Step 3.2: Create the DocStore**

Write `packages/intake/src/doc-store.ts`:

```typescript
/**
 * All learn doc I/O goes through DocStore — one code path for local disk and
 * S3/MinIO. Two modes:
 *   --out mode:  LocalFsAdapter(outDir), prefix "" — docs land exactly in outDir
 *   storage mode: getStorage() (or injected), prefix "gyms/<slug>/docs"
 */
import { readFile } from "node:fs/promises";
import { getStorage, LocalFsAdapter, slugFromUrl, describeStorage, type StorageAdapter } from "@milo/storage";

export class DocStore {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly prefix: string,
  ) {}

  private key(rel: string): string {
    return this.prefix ? `${this.prefix}/${rel}` : rel;
  }

  /** URI of the docs root, e.g. file:///Users/x/.milo/gyms/slug/docs or s3://b/gyms/slug/docs. */
  uri(): string {
    const base = describeStorage(this.storage);
    return this.prefix ? `${base}/${this.prefix}` : base;
  }

  async putJson(rel: string, value: unknown): Promise<void> {
    await this.storage.put(this.key(rel), Buffer.from(JSON.stringify(value, null, 2), "utf8"));
  }

  async putText(rel: string, text: string): Promise<void> {
    await this.storage.put(this.key(rel), Buffer.from(text, "utf8"));
  }

  async putFile(rel: string, absPath: string): Promise<void> {
    await this.storage.put(this.key(rel), await readFile(absPath));
  }

  async getJson(rel: string): Promise<unknown | null> {
    const buf = await this.storage.get(this.key(rel));
    return buf ? JSON.parse(buf.toString("utf8")) : null;
  }
}

export function resolveDocStore(opts: {
  url: string;
  outDir?: string;
  storage?: StorageAdapter;
  slug?: string;
}): DocStore {
  if (opts.storage) {
    return new DocStore(opts.storage, `gyms/${opts.slug ?? slugFromUrl(opts.url)}/docs`);
  }
  if (opts.outDir) {
    return new DocStore(new LocalFsAdapter(opts.outDir), "");
  }
  return new DocStore(getStorage(), `gyms/${opts.slug ?? slugFromUrl(opts.url)}/docs`);
}
```

- [ ] **Step 3.3: Add the dependency and write the failing tests**

In `packages/intake/package.json`, add to `dependencies` (alphabetical, after `@milo/schema`):

```json
    "@milo/storage": "workspace:*",
```

```bash
pnpm install
```

Add this import at the top of `packages/intake/test/intake.test.ts`:

```typescript
import { LocalFsAdapter } from "@milo/storage";
```

Append this describe block at the end of `packages/intake/test/intake.test.ts` (it reuses the existing fakes — `FakePlacesClient`, `FakePageFetcher`, `fakeChat`, `fakeFonts`, `fakeDownload`, `fakeSocialScraper`, fixtures `HOME`/`ABOUT`/`PRICING`/`CLASS`/`BUSINESS`/`CONTEXT`, and the `out` tmp dir):

```typescript
describe("runLearn storage mode", () => {
  it("writes docs to gyms/<slug>/docs/ via an injected storage adapter", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);
    const storage = new LocalFsAdapter(path.join(out, "storage"));

    const result = await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      slug: "ironanchor-com",
      storage,
      maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    const docsRoot = path.join(out, "storage", "gyms", "ironanchor-com", "docs");
    // Canonical top-level copies
    expect(JSON.parse(await readFile(path.join(docsRoot, "brand.json"), "utf8"))).toHaveProperty("colors");
    expect(JSON.parse(await readFile(path.join(docsRoot, "pages.json"), "utf8"))).toHaveProperty("pages");
    // Deprecated crawl/ duplicates (kept for the generate path)
    expect(JSON.parse(await readFile(path.join(docsRoot, "crawl", "brand.json"), "utf8"))).toHaveProperty("colors");
    expect(JSON.parse(await readFile(path.join(docsRoot, "crawl", "pages.json"), "utf8"))).toHaveProperty("pages");
    // Crawl bundle + markdown + structured docs
    expect(JSON.parse(await readFile(path.join(docsRoot, "crawl", "identity.json"), "utf8"))).toHaveProperty("found");
    expect(await readFile(path.join(docsRoot, "context.md"), "utf8")).toMatch(/iron anchor/i);
    expect(await readFile(path.join(docsRoot, "business.md"), "utf8")).toMatch(/iron anchor/i);
    expect(JSON.parse(await readFile(path.join(docsRoot, "context.json"), "utf8"))).toBeTruthy();
    // docsUri reported on the result; gym.json NOT written by runLearn
    expect(result.docsUri).toContain("gyms/ironanchor-com/docs");
    await expect(readFile(path.join(docsRoot, "gym.json"), "utf8")).rejects.toThrow();
  });

  it("emits verbose events to the injected logger", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);
    const verboseMsgs: string[] = [];
    const logger = { info: () => {}, warn: () => {}, verbose: (m: string) => verboseMsgs.push(m) };

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out,
      logger,
      maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    expect(verboseMsgs.some((m) => m.includes("crawled"))).toBe(true);
    expect(verboseMsgs.some((m) => m.includes("classified"))).toBe(true);
  });
});
```

- [ ] **Step 3.4: Run to confirm failure**

```bash
pnpm --filter @milo/intake exec vitest run --no-file-parallelism test/intake.test.ts 2>&1 | tail -12
```

Expected: FAIL — `storage`/`slug`/`logger` options and `result.docsUri` don't exist yet.

- [ ] **Step 3.5: Update the options and result interfaces**

In `packages/intake/src/intake.ts`:

Replace the import block lines 1–2:

```typescript
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
```

with:

```typescript
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type StorageAdapter } from "@milo/storage";
import { DocStore, resolveDocStore } from "./doc-store.ts";
import { consoleLogger, type MiloLogger } from "./logger.ts";
```

Add `docsUri` to `RunLearnResult` (after `integrations`):

```typescript
  integrations: Record<string, unknown>;
  /** URI of the docs root everything was written to, e.g. file:///Users/x/.milo/gyms/<slug>/docs */
  docsUri: string;
}
```

In `RunIntakeOptions`, make `outDir` optional and add the three new fields (replace the `outDir: string;` line and add after `socialScraper?`):

```typescript
  /** When set, docs are written directly into this dir (LocalFsAdapter, no key prefix) — preserves pre-storage behavior. */
  outDir?: string;
```

```typescript
  /** Injectable storage backend. Default: outDir mode → LocalFsAdapter(outDir); otherwise getStorage(). */
  storage?: StorageAdapter;
  /** Docs key slug. Default: slugFromUrl(url). Ignored in outDir mode. */
  slug?: string;
  /** Injectable logger. Default: consoleLogger (verbose suppressed). */
  logger?: MiloLogger;
```

Delete the now-unused helpers `exists` (lines 69–71) and `writeJson` (lines 73–76).

- [ ] **Step 3.6: Add logger params to the download helpers**

Replace the `downloadPageAssets` signature and body (lines 92–107) with:

```typescript
/** Download every unique image referenced by crawled pages. Returns original URL → local path. */
async function downloadPageAssets(
  pages: PageDocument[],
  assetsDir: string,
  downloadOne: (url: string, assetsDir: string, preferredName?: string) => Promise<string | null> = downloadAsset,
  logger?: MiloLogger,
): Promise<Record<string, string>> {
  const uniqueUrls = [...new Set(pages.flatMap((p) => p.images.map((i) => i.src)))];
  const results = await mapWithConcurrency(uniqueUrls, 5, async (url) => {
    const local = await downloadOne(url, assetsDir);
    if (local) logger?.verbose(`[learn] asset ${url} → ${local}`);
    return { url, local };
  });
  const map: Record<string, string> = {};
  for (const { url, local } of results) {
    if (local) map[url] = local;
  }
  return map;
}
```

Replace the `downloadGmbPhotos` signature (lines 131–137) with:

```typescript
async function downloadGmbPhotos(
  identity: IdentityCrawl,
  assetsDir: string,
  getPhotoUri: (photoName: string, maxWidthPx?: number) => Promise<string | null>,
  downloadOne: (url: string, assetsDir: string, preferredName?: string) => Promise<string | null> = downloadAsset,
  maxWidthPx = 1600,
  logger?: MiloLogger,
): Promise<DownloadedGmbAsset[]> {
```

and inside its `if (saved) {` block, add as the first line:

```typescript
      logger?.verbose(`[learn] gmb photo ${photo.name} → ${saved}`);
```

- [ ] **Step 3.7: Rewire `runLearn` — resolution, skipCrawl, crawl loop, writes**

At the top of `runLearn`, replace:

```typescript
  const rules = opts.rules ?? loadCrawlRules();
  const crawlDir = path.join(opts.outDir, "crawl");
  const pagesDir = path.join(crawlDir, "pages");
```

with:

```typescript
  const rules = opts.rules ?? loadCrawlRules();
  const logger = opts.logger ?? consoleLogger;
  const docs = resolveDocStore(opts);
  logger.info(`[learn] Writing docs to ${docs.uri()}`);
```

Replace the entire `if (opts.skipCrawl) { ... }` branch with:

```typescript
  if (opts.skipCrawl) {
    const pagesJson = await docs.getJson("crawl/pages.json");
    if (!pagesJson) {
      throw new Error(`No crawl bundle found at ${docs.uri()}/crawl. Run without --skip-crawl first.`);
    }
    inventory = PagesJson.parse(pagesJson);
    identity = IdentityCrawl.parse(await docs.getJson("crawl/identity.json"));
    brand = BrandCrawl.parse(await docs.getJson("crawl/brand.json"));
    pageDocs = await Promise.all(
      inventory.pages.map(async (p) =>
        PageDocument.parse(await docs.getJson(`crawl/pages/${p.slug}.json`))),
    );
    // Re-hydrate GMB assets so prompts still get photo context on re-runs.
    try {
      const gmbAssetsDoc = (await docs.getJson("crawl/gmb-assets.json")) as { assets?: typeof gmbAssets } | null;
      gmbAssets = gmbAssetsDoc?.assets ?? [];
    } catch { /* gmb-assets.json may not exist in older crawl bundles */ }
  } else {
```

In the Places block, replace both `console.warn` calls with `logger.warn` (same message text), and replace the `console.warn(\`Capped at ...\`)` call with `logger.warn` (same text).

In the crawl loop's worker, replace:

```typescript
          return extractPageDocument({ html: fetched.html, url, slug, baseUrl, fetchMethod: fetched.fetchMethod, llmBudget });
        } catch (e) {
          // Page fetch fails → skip page, log warning, continue. A single bad page
          // (HTTP error, network failure) must never crash the whole run.
          console.warn(`[intake] skipping ${url}: ${(e as Error).message}`);
          return null;
        }
```

with:

```typescript
          const doc = extractPageDocument({ html: fetched.html, url, slug, baseUrl, fetchMethod: fetched.fetchMethod, llmBudget });
          logger.verbose(`[learn] crawled ${url} (via ${fetched.fetchMethod}, ${doc.images.length} images)`);
          return doc;
        } catch (e) {
          // Page fetch fails → skip page, log warning, continue. A single bad page
          // (HTTP error, network failure) must never crash the whole run.
          logger.warn(`[intake] skipping ${url}: ${(e as Error).message}`);
          return null;
        }
```

Replace the per-page classification line:

```typescript
    pageDocs = await mapWithConcurrency(rawDocs, opts.concurrency, (doc) => classifyPage(doc, { chat: opts.chat, model: opts.fastModel }));
```

with:

```typescript
    pageDocs = await mapWithConcurrency(rawDocs, opts.concurrency, async (doc) => {
      const t0 = Date.now();
      const classified = await classifyPage(doc, { chat: opts.chat, model: opts.fastModel });
      logger.verbose(`[learn] classified ${doc.slug} (${Date.now() - t0}ms)`);
      return classified;
    });
```

Replace the social-scrape `console.log` with `logger.info` (same text).

Replace the whole Step 4b block — from `const assetsDir = path.join(opts.outDir, "assets");` through the per-page `writeJson` loop — with:

```typescript
    // --- Step 4b: download GMB photos + page assets so generated sites don't hot-link source CDNs
    // Downloads stage in a tmp dir, then upload through the storage seam — one code
    // path for local disk and S3. pageDocs keep "/assets/<name>" web paths either way.
    const assetsDir = await mkdtemp(path.join(os.tmpdir(), "milo-assets-"));
    gmbAssets = await downloadGmbPhotos(identity, assetsDir, opts.places.getPhotoUri.bind(opts.places), opts.downloadOne, opts.gmbPhotoMaxWidthPx, logger);
    const assetMap = await downloadPageAssets(pageDocs, assetsDir, opts.downloadOne, logger);
    attachLocalAssetPaths(pageDocs, assetMap);

    for (const f of await readdir(assetsDir)) {
      await docs.putFile(`assets/${f}`, path.join(assetsDir, f));
    }
    await rm(assetsDir, { recursive: true, force: true });

    // --- persist crawl bundle
    const gmbAssetsDoc = {
      downloadedAt: opts.discoveredAt,
      count: gmbAssets.length,
      assets: gmbAssets,
    };
    await docs.putJson("crawl/identity.json", identity);
    await docs.putJson("crawl/gmb-assets.json", gmbAssetsDoc);
    await docs.putJson("crawl/links.json", linkMap);
    // Canonical top-level copies (Phase 2 readers). crawl/ duplicates kept for the
    // deprecated generate path — apps/cli/src/generate.ts reads crawl/brand.json + crawl/pages.json.
    await docs.putJson("brand.json", brand);
    await docs.putJson("pages.json", inventory);
    await docs.putJson("crawl/brand.json", brand);
    await docs.putJson("crawl/pages.json", inventory);
    logger.info(`[intake] Link map: ${linkMap.nodes.length} internal URLs (${linkMap.nodes.filter((n) => n.crawled).length} crawled, ${linkMap.nodes.filter((n) => !n.crawled).length} mapped-only)`);
    logger.info(`[intake] Downloaded ${gmbAssets.length} GMB photos + ${Object.keys(assetMap).length} page assets`);
    for (const doc of pageDocs) await docs.putJson(`crawl/pages/${doc.slug}.json`, doc);
```

Replace the Step 5 block — from `const business = await classifyBusiness(...)` through the `console.log(\`[learn] Wrote ...\`)` line — with:

```typescript
  const tBiz = Date.now();
  const business = await classifyBusiness({ chat: opts.chat, model: opts.fastModel, pages: pageDocs, brand, identity, gmbAssets });
  logger.verbose(`[learn] classifyBusiness model=${opts.fastModel} (${Date.now() - tBiz}ms)`);
  const integrations = buildIntegrations(brand);
  const tCtx = Date.now();
  const context = await analyzeContext({ chat: opts.chat, model: opts.capableModel, pages: pageDocs, budgets, identity, brand, gmbAssets });
  logger.verbose(`[learn] analyzeContext model=${opts.capableModel} (${Date.now() - tCtx}ms)`);
  const placeholderArchetypes = missingArchetypes(pageDocs);
  if (placeholderArchetypes.length > 0) {
    logger.warn(`[intake] Thin input — creating placeholder pages for: ${placeholderArchetypes.join(", ")}`);
  }

  // Write docs in both JSON (template compat) and Markdown (new format)
  await docs.putJson("context.json", context);
  await docs.putJson("business.json", business);
  await docs.putJson("integrations.json", integrations);
  await docs.putText("context.md", contextToMarkdown(opts.gymName, context));
  await docs.putText("business.md", businessToMarkdown(opts.gymName, business));

  logger.info(`[learn] Wrote docs to ${docs.uri()}`);

  return { context, business, identity, brand, pageDocs, gmbAssets, placeholderArchetypes, budgets, integrations, docsUri: docs.uri() };
```

(The `budgets` line and `missingArchetypes` call are unchanged — shown for anchor context.)

- [ ] **Step 3.8: Rewire `runIntake`**

Replace the whole `runIntake` function with:

```typescript
/** Backward-compat wrapper: runs runLearn then generates gym.json. */
export async function runIntake(opts: RunLearnOptions): Promise<void> {
  const result = await runLearn(opts);
  const { gym } = await generateSite({
    chat: opts.chat,
    model: opts.capableModel,
    pages: result.pageDocs,
    budgets: result.budgets,
    identity: result.identity,
    brand: result.brand,
    context: result.context,
    business: result.business,
    placeholderArchetypes: result.placeholderArchetypes,
    gmbAssets: result.gmbAssets,
  });
  const docs = resolveDocStore(opts);
  await docs.putJson("gym.json", gym);
  const logger = opts.logger ?? consoleLogger;
  logger.info(`[intake] Wrote gym.json to ${docs.uri()}`);
}
```

- [ ] **Step 3.9: Update exports and run the tests**

In `packages/intake/src/index.ts`, append:

```typescript
export { consoleLogger, verboseConsoleLogger } from "./logger.ts";
export type { MiloLogger } from "./logger.ts";
```

```bash
pnpm --filter @milo/intake exec vitest run --no-file-parallelism 2>&1 | tail -12
```

Expected: ALL tests pass — pre-existing `runLearn`/`runIntake` tests (they use `outDir` mode, layout unchanged except the two additive top-level JSON copies) plus the new storage-mode and verbose tests.

- [ ] **Step 3.10: Typecheck and commit**

```bash
pnpm --filter @milo/intake exec tsc --noEmit
git add packages/intake
git commit -m "feat(intake): runLearn writes docs through @milo/storage at gyms/<slug>/docs/ + logger seam

--out mode unchanged (LocalFsAdapter, no prefix). Assets stage in tmp and
upload via the adapter. brand.json/pages.json written top-level (canonical)
and in crawl/ (deprecated duplicate for the generate path)."
```

---

## Task 4: CLI — `milo learn --verbose` + storage-mode default

**Files:**
- Modify: `apps/cli/src/milo.ts` (`case "learn":` only — the deprecated `case "intake":` stays as-is)

- [ ] **Step 4.1: Update the learn case**

In `apps/cli/src/milo.ts`, in `case "learn":`, replace:

```typescript
      const outDir = path.resolve(flag("out", learnArgs) ?? "./learn-output");
```

with:

```typescript
      const outFlag = flag("out", learnArgs);
      const verbose = learnArgs.includes("--verbose");
```

In the same case, replace the dynamic import line:

```typescript
      const { runLearn, createRealPlacesClient, createRealPageFetcher, loadCrawlRules } = await import("@milo/intake");
```

with:

```typescript
      const { runLearn, createRealPlacesClient, createRealPageFetcher, loadCrawlRules, verboseConsoleLogger } = await import("@milo/intake");
```

In the `runLearn({...})` call, replace the `outDir,` line with:

```typescript
        ...(outFlag ? { outDir: path.resolve(outFlag) } : {}),
        ...(verbose ? { logger: verboseConsoleLogger() } : {}),
```

Replace the final success line:

```typescript
      console.log(`[learn] Done. ${result.pageDocs.length} pages documented. Docs at ${outDir}`);
```

with:

```typescript
      console.log(`[learn] Done. ${result.pageDocs.length} pages documented. Docs at ${result.docsUri}`);
```

Update the JSDoc usage line near the top of the file:

```typescript
 *   milo learn    --url <url> --name <gym-name> --city <city> --state <state> [--out <dir>] [--verbose]
```

- [ ] **Step 4.2: Typecheck**

```bash
pnpm --filter cli exec tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 4.3: Smoke test**

```bash
node apps/cli/src/milo.ts learn 2>&1
```

Expected: `--url is required`.

- [ ] **Step 4.4: Commit**

```bash
git add apps/cli/src/milo.ts
git commit -m "feat(cli): milo learn --verbose + storage-mode default when --out absent"
```

---

## Task 5: CLI — `milo clone --deploy`

`--deploy` is opt-in. It validates publish config *before* the build (fail fast), synthesizes a `publish.json` in the out dir on first deploy (slug derived from the URL — same slug as the docs), then publishes `<out>/full-site/` to staging after a successful build.

**Files:**
- Modify: `apps/cli/src/milo.ts` (`case "clone":`)
- Modify: `apps/cli/package.json`

- [ ] **Step 5.1: Add the @milo/storage dependency**

In `apps/cli/package.json`, add to `dependencies` (alphabetical, after `@milo/schema`):

```json
    "@milo/storage": "workspace:*",
```

```bash
pnpm install
```

- [ ] **Step 5.2: Implement the flag**

In `apps/cli/src/milo.ts`, in `case "clone":`, immediately after the URL validation block, insert:

```typescript
    // --deploy: opt-in staging publish after a successful build. Validate config
    // BEFORE building so a missing KVS ARN fails in seconds, not after a 5-min build.
    const deploy = cloneArgs.includes("--deploy");
    let deployOutAbs: string | null = null;
    if (deploy) {
      const out = flag("out", cloneArgs);
      if (!out) {
        console.error("--deploy requires --out <dir> so the built site location is known");
        process.exit(1);
      }
      deployOutAbs = path.resolve(out);
      const publishJsonPath = path.join(deployOutAbs, "publish.json");
      if (!existsSync(publishJsonPath)) {
        const kvsArn = process.env.CLOUDFRONT_KVS_ARN;
        if (!kvsArn) {
          console.error("--deploy: CLOUDFRONT_KVS_ARN is required on first deploy (or place a publish.json in --out)");
          process.exit(1);
        }
        const { slugFromUrl } = await import("@milo/storage");
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(deployOutAbs, { recursive: true });
        writeFileSync(publishJsonPath, JSON.stringify({ slug: slugFromUrl(cloneUrl), kvsArn }, null, 2) + "\n");
        console.log(`[clone] Created publish.json — slug: ${slugFromUrl(cloneUrl)}`);
      }
    }
```

In the same case, add `"--deploy"` to both sets:

```typescript
    const handledFlags = new Set(["--refresh-docs", "--template", "--out", "--mode", "--name", "--city", "--state", "--url", "--deploy"]);
    const booleanFlags = new Set(["--refresh-docs", "--deploy"]);
```

Replace the final line of the case:

```typescript
    process.exit(run("node", engineArgs, ROOT));
```

with:

```typescript
    const buildStatus = run("node", engineArgs, ROOT);
    if (buildStatus !== 0) process.exit(buildStatus);

    if (deployOutAbs) {
      try {
        const config = await resolveOrInitConfig({ gymJsonPath: path.join(deployOutAbs, "gym.json") });
        const s3 = createRealS3Adapter({ bucket: config.bucket, region: config.region, awsProfile: config.awsProfile });
        const kvs = createRealKvsAdapter({ kvsArn: config.kvsArn, region: config.region, awsProfile: config.awsProfile });
        await publishStaging({ config, distDir: path.join(deployOutAbs, "full-site"), s3, kvs });
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
    process.exit(0);
```

(`resolveOrInitConfig` is already imported from `@milo/publish` at the top of the file. It reads `publish.json` — written above — and never touches the nonexistent `gym.json`.)

Update the usage error in the same case:

```typescript
      console.error("Usage: milo clone <url> [--template <id>] [--refresh-docs] [--deploy] [--out <dir>]");
```

- [ ] **Step 5.3: Typecheck and smoke test**

```bash
pnpm --filter cli exec tsc --noEmit 2>&1 | head -10
node apps/cli/src/milo.ts clone 2>&1
node apps/cli/src/milo.ts clone https://example.com --deploy 2>&1
```

Expected: no type errors; usage error includes `--deploy`; the third command fails fast with `--deploy requires --out <dir> ...` (no build attempted).

- [ ] **Step 5.4: Commit**

```bash
git add apps/cli/src/milo.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): milo clone --deploy — opt-in staging publish after successful build

Fail-fast config check before build; synthesizes publish.json with a
URL-derived slug on first deploy."
```

---

## Task 6: Full verification + no-regress clone

- [ ] **Step 6.1: Run every affected suite**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm --filter @milo/storage test 2>&1 | tail -4
pnpm --filter @milo/schema test 2>&1 | tail -4
pnpm --filter @milo/intake exec vitest run --no-file-parallelism 2>&1 | tail -4
pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism 2>&1 | tail -4
```

Expected: all green.

- [ ] **Step 6.2: No-regress clone**

```bash
mkdir -p /tmp/milo-clone-noregress
node apps/cli/src/milo.ts clone https://speakeasyofstrength.com --mode core --out /tmp/milo-clone-noregress 2>&1 | tail -3
```

Expected: `✓ assembled full-site/ with 47/47 pages` — identical to the pre-change baseline. (Capture cache makes this fast.)

- [ ] **Step 6.3: Optional MinIO smoke (manual)**

```bash
docker compose up -d minio
STORAGE_BUCKET=milo-dev STORAGE_ENDPOINT=http://localhost:9000 STORAGE_KEY=minioadmin STORAGE_SECRET=minioadmin \
  node apps/cli/src/milo.ts learn --url <url> --name <name> --city <city> --state <state> --verbose 2>&1 | tail -5
```

Expected: startup line shows `s3://milo-dev`, docs appear under `gyms/<slug>/docs/` in the MinIO console (http://localhost:9001). Requires the bucket to exist (create once in the console).

- [ ] **Step 6.4: Mark the parent spec section implemented**

In `docs/superpowers/specs/2026-08-03-milo-cli-pipeline-design.md`, in the "Docs Storage Structure" section, append after the intro line:

```markdown
**Status:** Implemented 2026-08-03 — see `2026-08-03-docs-storage-plumbing-design.md`.
```

```bash
git add docs/superpowers/specs/2026-08-03-milo-cli-pipeline-design.md
git commit -m "docs(milo): mark docs storage structure implemented"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] `@milo/storage` promotion + env resolution + `slugFromUrl` — Task 1
- [x] `runLearn` storage-backed writes, key layout, top-level + crawl/ duplicate brand/pages — Task 3
- [x] `--out` override preserves byte-for-byte locations — Task 3 (`resolveDocStore` outDir mode)
- [x] Logger seam + `--verbose` on learn — Tasks 3 + 4
- [x] `LearnJob.verbose`, `CloneJob.deploy` schema fields — Task 2
- [x] `clone --deploy` with fail-fast config check, real-S3 staging only — Task 5
- [x] Backend visibility log line — Task 3 step 3.7 (`[learn] Writing docs to ...`)
- [x] S3 write failures propagate — DocStore never swallows adapter errors (no try/catch)
- [x] No-regress clone run — Task 6
- [x] Engine ENOENT papercuts — explicitly excluded (separate task per spec Section 5)

**Type consistency:**
- `MiloLogger` defined in `packages/intake/src/logger.ts` (Task 3.1) — used in intake.ts, doc-store doesn't need it, CLI imports `verboseConsoleLogger` from `@milo/intake` (exported Task 3.9)
- `DocStore`/`resolveDocStore` in `packages/intake/src/doc-store.ts` (Task 3.2) — used in intake.ts (3.7, 3.8)
- `RunLearnResult.docsUri` added in 3.5, returned in 3.7, consumed in CLI Task 4.1
- `slugFromUrl`/`describeStorage` from `@milo/storage` (Task 1.4) — used in doc-store.ts and milo.ts
- `StorageAdapter` type imported from `@milo/storage` everywhere — no lingering `storage/adapter.ts` imports after Task 1.6

**Deferred (out of scope):**
- Chunk B (docs→clone consumption) — separate spec
- Admin direct function calls (parent spec item 4) — unchanged; admin's `learn --out seedDir` flow keeps working via outDir mode
- Engine ENOENT papercuts — separate task
