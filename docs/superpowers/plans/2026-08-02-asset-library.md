# Asset Library — per-business media catalog

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every cloned business a durable **media catalog** — a `library.json` + `library/` directory that lives beside `site.json` — so the clone engine can catalog, tag, search, and re-place images instead of blindly swapping opaque files. Every image (whether the owner uploaded it or the engine AI-generated it) becomes an addressable `Asset` with CV-derived tags (subjects, mood, setting, quality, a one-sentence description) and a reverse `usages[]` index of where it is placed. The library is the substrate that lets an agent answer "put a welcoming kettlebell photo in the hero" by *searching* the catalog rather than regenerating from scratch.

**Architecture:** The library is a JSON document + a files directory, both under `businessDir` (== `site.dir` for now):

```
<businessDir>/
  site.json              # existing manifest — each asset entry gains an optional `assetId`
  library.json           # NEW — the AssetLibrary (version, businessId, assets keyed by id)
  library/               # NEW — the actual catalogued image files (ast_<uuid>.webp, …)
  assets/                # existing rehost dir (swapAsset writes here)
  astro/public/assets/   # existing Astro static dir (swapAsset writes here too)
```

Five layers, each a task:

1. **Store (T0)** — `library.ts`: the types + pure JSON CRUD (`loadLibrary`/`saveLibrary`/`emptyLibrary`/`addAsset`/`getAsset`/`updateAssetTags`/`archiveAsset`/`recordUsage`). No CV, no image I/O — just the document.
2. **Ingest (T1)** — `ingest.ts`: `ingestAsset` copies a file into `library/`, sniffs mime + dimensions, writes an `Asset` with `tags.pending:true`, then fires async CV tagging via `tagAsset` (a Claude-vision `llmJson` call that fills `AssetTags`).
3. **Find (T2)** — `find.ts`: `findAsset(library, query)` — a **pure** query function. Hard-filter active assets, then rank by cosine similarity (embedding) or recency (fallback). No I/O, no network.
4. **Place (T3)** — a `placeAsset` EditOp: resolves `assetId → file` from the library, calls the existing `swapAsset(site, alias, file)`, then `recordUsage`. Wires into the `EditOp` union, `EditOpSchema`, `apply.ts` dispatch, `plan.ts` validation, `targetIdentity`, and the planner prompt.
5. **Refactor + owner surface (T4–T7)** — `generateAsset` refactors to *generate → ingest → place* (the generated image now lives in the library); `uploadAsset` is the owner-facing "I have a photo, put it here" EditOp; `migrate.ts` back-fills the library from an existing `site.json`; everything gets exported.

`findAsset` is deliberately **not** an EditOp — it is a read-only query an agent runs to *choose* an `assetId`, which it then feeds to `placeAsset`/`uploadAsset`. `placeAsset` reuses `swapAsset` verbatim: it does NOT reimplement asset storage, filename sniffing, ref rewriting, or `site.json` updates. This keeps the rollback oracle (`editableHash` over editable files) intact — a placed asset is just a `swapAsset` under the hood.

**Tech Stack:** Node 24 TypeScript, ESM (`.ts` import specifiers — repo convention), Vitest, Zod. CV tagging uses `llmJson` from `@milo/llm` with a Zod schema for `AssetTags` and a Claude **vision** message (`ChatMessage.content` as `ChatContentPart[]` with an `image_url` data-URI part — the client base64-encodes it). All Claude-vision calls are **mocked in every test** (dependency-injected `ChatFn`). Mime/dimension sniffing is a tiny local header parser (PNG/JPEG/WebP/GIF) — no new dependency. Embeddings are a **stubbed no-op for v1** (`embedding` left `undefined`; `findAsset` falls back to recency ranking) — the seam exists but is not wired to a model yet.

**Key decisions already locked (do not re-litigate):**
- `source` is `"upload" | "generated"` only. Cloned/rehosted assets from a site build are treated as **uploads** the engine performed. There is no "captured" source.
- **No consent management.** The owner removes images they don't want (`archiveAsset`). No cascade, no legal tracking.
- **Safety gate rationale** (lives in `safety.ts` comments): AI generation refuses people/gym-interiors because *real members know what their gym looks like and who trains there* — a fake face or fake gym floor is immediately recognizable and destroys trust with the real community. Equipment, food, and textures are safe because they are generic. `hasPeople:true` ⇒ `source` must be `"upload"` (the engine never generates people).
- **Quality scoring** is part of CV tagging: `quality: "low"|"medium"|"high"` + optional `qualityNotes?: string[]`.
- `businessDir` == `site.dir` for now (the library lives alongside the projected site). Later it becomes a separate per-gym directory — every function threads `businessDir` explicitly so that change is a call-site swap, never a rewrite.

---

## Commands (used throughout)

Run the asset-library suite (scoped):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/
```

Typecheck:
```bash
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```

Full edit + assets gate (T3–T7 — the op touches the shared edit surfaces):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/ test/edit/
```

Full suite (T7 final gate):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism
```

**TDD discipline (every task):** write the test first, run it, watch it FAIL for the intended reason (red), implement, run again, watch it PASS (green), typecheck clean, then commit with explicit `git add` paths. Never `git add -A`.

---

## Data model (final shape — implemented verbatim in T0)

```ts
// src/assets/library.ts

export interface Asset {
  id: string;                         // "ast_<uuid>"
  source: "upload" | "generated";
  file: string;                       // relative to businessDir: "library/ast_x.webp"
  mime: string;
  dimensions: { w: number; h: number };
  aspectRatio: "16:9" | "1:1" | "4:3" | "3:2" | "other";
  bytes: number;
  tags: AssetTags;
  altText?: string;
  usages: AssetUsage[];               // reverse index: where it's placed
  status: "active" | "archived";
  createdAt: string;                  // ISO
}

export interface AssetTags {
  pending: boolean;                   // true while CV tagging is running
  hasPeople: boolean;                 // if true, source must be "upload" (not generated)
  subjects: string[];                 // ["barbell", "kettlebell", "squat rack"]
  activity?: string;                  // "lifting" | "coaching" | "stretching" | "eating"
  mood: string[];                     // ["energetic", "welcoming", "focused"]
  setting: "interior" | "exterior" | "studio" | "abstract" | "food" | "product";
  description: string;                // one sentence — source for the embedding
  embedding?: number[];               // cosine-similarity retrieval
  quality: "low" | "medium" | "high";
  qualityNotes?: string[];            // ["blurry", "overexposed", "low-resolution"]
}

export interface AssetUsage { alias: string; route: string; section: string; }

export interface AssetLibrary {
  version: 1;
  businessId: string;
  assets: Record<string, Asset>;      // keyed by id
}
```

---

## T0 — `library.ts`: types + pure JSON CRUD

**Files:**
- CREATE `src/assets/library.ts`
- CREATE `test/assets/library.test.ts`

**What it does:** Defines the data model above and pure functions to read/write/mutate an `AssetLibrary`. `loadLibrary`/`saveLibrary` are the only functions that touch the filesystem (JSON only — no image files). Everything else operates on an in-memory `AssetLibrary`. All mutators return a **new** library object (immutable update) so callers can't accidentally alias state; `saveLibrary` persists it.

### Step 1 (red) — write `test/assets/library.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyLibrary,
  loadLibrary,
  saveLibrary,
  addAsset,
  getAsset,
  updateAssetTags,
  archiveAsset,
  recordUsage,
  type Asset,
  type AssetLibrary,
  type AssetTags,
} from "../../src/assets/library.ts";

function pendingTags(): AssetTags {
  return {
    pending: true,
    hasPeople: false,
    subjects: [],
    mood: [],
    setting: "product",
    description: "",
    quality: "medium",
  };
}

function fixtureAsset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    source: "upload",
    file: `library/${id}.webp`,
    mime: "image/webp",
    dimensions: { w: 1600, h: 900 },
    aspectRatio: "16:9",
    bytes: 12345,
    tags: pendingTags(),
    usages: [],
    status: "active",
    createdAt: "2026-08-02T00:00:00.000Z",
    ...over,
  };
}

describe("emptyLibrary", () => {
  it("creates a v1 library for a businessId with no assets", () => {
    const lib = emptyLibrary("biz_123");
    expect(lib.version).toBe(1);
    expect(lib.businessId).toBe("biz_123");
    expect(lib.assets).toEqual({});
  });
});

describe("loadLibrary / saveLibrary", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns an empty library when library.json does not exist", () => {
    const lib = loadLibrary(dir, "biz_123");
    expect(lib.assets).toEqual({});
    expect(lib.businessId).toBe("biz_123");
    // loadLibrary must NOT write anything as a side effect.
    expect(fs.existsSync(path.join(dir, "library.json"))).toBe(false);
  });

  it("round-trips a saved library through disk", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    saveLibrary(dir, lib);
    expect(fs.existsSync(path.join(dir, "library.json"))).toBe(true);
    const reloaded = loadLibrary(dir, "biz_123");
    expect(reloaded).toEqual(lib);
  });

  it("saveLibrary writes trailing-newline pretty JSON (repo convention)", () => {
    saveLibrary(dir, emptyLibrary("biz_123"));
    const raw = fs.readFileSync(path.join(dir, "library.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  "); // pretty-printed (2-space indent)
  });

  it("loadLibrary uses the businessId already stored in the file", () => {
    saveLibrary(dir, emptyLibrary("biz_original"));
    // Passing a different fallback id must NOT override the persisted one.
    const lib = loadLibrary(dir, "biz_fallback");
    expect(lib.businessId).toBe("biz_original");
  });
});

describe("addAsset / getAsset", () => {
  it("adds an asset keyed by id and returns a NEW library (immutability)", () => {
    const before = emptyLibrary("biz_123");
    const after = addAsset(before, fixtureAsset("ast_a"));
    expect(before.assets).toEqual({});            // original untouched
    expect(after.assets["ast_a"]?.id).toBe("ast_a");
    expect(getAsset(after, "ast_a")?.id).toBe("ast_a");
  });

  it("getAsset returns undefined for an unknown id", () => {
    expect(getAsset(emptyLibrary("biz_123"), "ast_missing")).toBeUndefined();
  });

  it("throws when adding a duplicate id (ids are unique)", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    expect(() => addAsset(lib, fixtureAsset("ast_a"))).toThrow(/ast_a/);
  });
});

describe("updateAssetTags", () => {
  it("replaces the tags of an existing asset and clears pending", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const filled: AssetTags = {
      pending: false,
      hasPeople: false,
      subjects: ["barbell", "weight plate"],
      activity: "lifting",
      mood: ["focused", "energetic"],
      setting: "product",
      description: "A loaded barbell resting on a gym platform.",
      quality: "high",
    };
    const after = updateAssetTags(lib, "ast_a", filled);
    expect(after.assets["ast_a"].tags).toEqual(filled);
    // original untouched
    expect(lib.assets["ast_a"].tags.pending).toBe(true);
  });

  it("throws for an unknown id", () => {
    expect(() => updateAssetTags(emptyLibrary("biz_123"), "ast_x", pendingTags())).toThrow(/ast_x/);
  });
});

describe("archiveAsset", () => {
  it("flips status to archived without deleting the record", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const after = archiveAsset(lib, "ast_a");
    expect(after.assets["ast_a"].status).toBe("archived");
    expect(lib.assets["ast_a"].status).toBe("active"); // immutable
  });

  it("throws for an unknown id", () => {
    expect(() => archiveAsset(emptyLibrary("biz_123"), "ast_x")).toThrow(/ast_x/);
  });
});

describe("recordUsage", () => {
  it("appends a usage entry to the reverse index", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const after = recordUsage(lib, "ast_a", { alias: "hero-image", route: "/", section: "HeroSection" });
    expect(after.assets["ast_a"].usages).toEqual([
      { alias: "hero-image", route: "/", section: "HeroSection" },
    ]);
    expect(lib.assets["ast_a"].usages).toEqual([]); // immutable
  });

  it("de-duplicates identical usage entries (same alias+route+section)", () => {
    let lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const usage = { alias: "hero-image", route: "/", section: "HeroSection" };
    lib = recordUsage(lib, "ast_a", usage);
    lib = recordUsage(lib, "ast_a", usage);
    expect(lib.assets["ast_a"].usages).toHaveLength(1);
  });

  it("records two DIFFERENT placements of the same asset", () => {
    let lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    lib = recordUsage(lib, "ast_a", { alias: "hero-image", route: "/", section: "HeroSection" });
    lib = recordUsage(lib, "ast_a", { alias: "about-photo", route: "/about/", section: "AboutSection" });
    expect(lib.assets["ast_a"].usages).toHaveLength(2);
  });

  it("throws for an unknown id", () => {
    expect(() => recordUsage(emptyLibrary("biz_123"), "ast_x", { alias: "a", route: "/", section: "S" })).toThrow(/ast_x/);
  });
});
```

Run — expect FAIL (module does not exist):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/library.test.ts
```
Expected output: `Failed to resolve import "../../src/assets/library.ts"` (or a suite of failing assertions once the file is stubbed).

### Step 2 (green) — write `src/assets/library.ts`

```ts
/**
 * library.ts — the per-business media catalog (Asset Library) data model + pure JSON CRUD.
 *
 * The library is a single JSON document (`<businessDir>/library.json`) alongside `site.json`,
 * plus a `library/` directory of the actual image files. This module owns ONLY the document:
 * the types, the on-disk (de)serialization, and immutable mutators. It performs NO image I/O
 * and NO CV — that lives in ingest.ts. Every mutator returns a NEW library so callers can't
 * alias mutable state; persist with saveLibrary.
 */
import fs from "node:fs";
import path from "node:path";

export interface Asset {
  id: string;                         // "ast_<uuid>"
  source: "upload" | "generated";
  file: string;                       // relative to businessDir: "library/ast_x.webp"
  mime: string;
  dimensions: { w: number; h: number };
  aspectRatio: "16:9" | "1:1" | "4:3" | "3:2" | "other";
  bytes: number;
  tags: AssetTags;
  altText?: string;
  usages: AssetUsage[];               // reverse index: where it's placed
  status: "active" | "archived";
  createdAt: string;                  // ISO
}

export interface AssetTags {
  pending: boolean;                   // true while CV tagging is running
  hasPeople: boolean;                 // if true, source must be "upload" (not generated)
  subjects: string[];                 // ["barbell", "kettlebell", "squat rack"]
  activity?: string;                  // "lifting" | "coaching" | "stretching" | "eating"
  mood: string[];                     // ["energetic", "welcoming", "focused"]
  setting: "interior" | "exterior" | "studio" | "abstract" | "food" | "product";
  description: string;                // one sentence — source for the embedding
  embedding?: number[];               // cosine-similarity retrieval
  quality: "low" | "medium" | "high";
  qualityNotes?: string[];            // ["blurry", "overexposed", "low-resolution"]
}

export interface AssetUsage { alias: string; route: string; section: string; }

export interface AssetLibrary {
  version: 1;
  businessId: string;
  assets: Record<string, Asset>;      // keyed by id
}

const LIBRARY_FILE = "library.json";

/** Fresh, empty library for a business. */
export function emptyLibrary(businessId: string): AssetLibrary {
  return { version: 1, businessId, assets: {} };
}

/**
 * Read the library from `<businessDir>/library.json`. If the file does not exist,
 * return an empty library for `fallbackBusinessId` WITHOUT writing anything.
 * If the file exists, the businessId it carries wins over the fallback.
 */
export function loadLibrary(businessDir: string, fallbackBusinessId: string): AssetLibrary {
  const p = path.join(businessDir, LIBRARY_FILE);
  if (!fs.existsSync(p)) return emptyLibrary(fallbackBusinessId);
  return JSON.parse(fs.readFileSync(p, "utf8")) as AssetLibrary;
}

/** Persist the library to `<businessDir>/library.json` (pretty JSON, trailing newline). */
export function saveLibrary(businessDir: string, library: AssetLibrary): void {
  const p = path.join(businessDir, LIBRARY_FILE);
  fs.writeFileSync(p, JSON.stringify(library, null, 2) + "\n");
}

/** Add an asset keyed by its id. Throws if the id already exists (ids are unique). */
export function addAsset(library: AssetLibrary, asset: Asset): AssetLibrary {
  if (library.assets[asset.id]) {
    throw new Error(`addAsset: asset id already exists: ${asset.id}`);
  }
  return { ...library, assets: { ...library.assets, [asset.id]: asset } };
}

/** Look up an asset by id, or undefined. */
export function getAsset(library: AssetLibrary, id: string): Asset | undefined {
  return library.assets[id];
}

/** Replace an asset's tags (used when async CV tagging completes). Throws if the id is unknown. */
export function updateAssetTags(library: AssetLibrary, id: string, tags: AssetTags): AssetLibrary {
  const asset = library.assets[id];
  if (!asset) throw new Error(`updateAssetTags: unknown asset id: ${id}`);
  return { ...library, assets: { ...library.assets, [id]: { ...asset, tags } } };
}

/** Flip an asset to archived (the owner removed it). The record is kept. Throws if unknown. */
export function archiveAsset(library: AssetLibrary, id: string): AssetLibrary {
  const asset = library.assets[id];
  if (!asset) throw new Error(`archiveAsset: unknown asset id: ${id}`);
  return { ...library, assets: { ...library.assets, [id]: { ...asset, status: "archived" } } };
}

/**
 * Append a placement to an asset's reverse-usage index. Identical (alias+route+section)
 * entries are de-duplicated so re-placing the same asset in the same slot is idempotent.
 * Throws if the id is unknown.
 */
export function recordUsage(library: AssetLibrary, id: string, usage: AssetUsage): AssetLibrary {
  const asset = library.assets[id];
  if (!asset) throw new Error(`recordUsage: unknown asset id: ${id}`);
  const exists = asset.usages.some(
    (u) => u.alias === usage.alias && u.route === usage.route && u.section === usage.section,
  );
  const usages = exists ? asset.usages : [...asset.usages, usage];
  return { ...library, assets: { ...library.assets, [id]: { ...asset, usages } } };
}
```

Run — expect PASS:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/library.test.ts
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```
Expected: all `library.test.ts` cases green; tsc exits 0.

### Commit T0
```bash
git add packages/clone-engine/src/assets/library.ts packages/clone-engine/test/assets/library.test.ts
git commit -m "feat(assets): asset library data model + pure JSON CRUD (T0)"
```

---

## T1 — `ingest.ts`: copy into `library/`, sniff, create record, async CV tag

**Files:**
- CREATE `src/assets/ingest.ts`
- CREATE `test/assets/ingest.test.ts`

**What it does:**
- `ingestAsset(businessDir, opts)` — copies `opts.file` into `<businessDir>/library/ast_<uuid>.<ext>`, sniffs `mime` + `dimensions` (→ derives `aspectRatio` + `bytes`), creates an `Asset` with `tags.pending:true`, `addAsset` + `saveLibrary`, then **fires** async CV tagging (`tagAsset`) and returns `{ assetId, library }`. The returned promise resolves as soon as the record is persisted; tagging completes in the background (awaited by tests via the returned `tagging` promise so there is no race).
- `tagAsset(businessDir, assetId, opts)` — reads the file back, base64-encodes it into a Claude-vision message, calls `llmJson(AssetTagsSchema, …)` to fill `AssetTags` (minus `embedding`), then `loadLibrary` → `updateAssetTags` → `saveLibrary`.

**Ingest opts:**
```ts
export interface IngestOpts {
  file: string;                       // absolute path to the source image
  source: "upload" | "generated";
  businessId?: string;                // fallback for a brand-new library
  brief?: string;                     // generation brief (hint for the tagger)
  altText?: string;
  chat?: ChatFn;                      // injected Claude client (mocked in tests)
  model?: string;                     // vision model id
  now?: () => Date;                   // injectable clock (tests pin createdAt)
}
```

**Design notes threaded into the code:**
- Async tagging is **fire-and-forget from the caller's perspective**, but `ingestAsset` returns the in-flight `tagging: Promise<void>` so tests (and callers that want to block) can await it. `tagAsset` re-loads the library before writing, so a concurrent write to a *different* asset is not clobbered.
- If `chat`/`model` are omitted, tagging is a **no-op** that leaves `pending:true` — ingest never fails just because no tagger is wired. (Real callers always pass a `chat`.)
- Mime/dimension sniffing supports PNG, JPEG, WebP (VP8/VP8L/VP8X), and GIF — the formats the engine actually rehosts. Unknown headers → throw (we never catalog a file we can't measure).
- `embedding` is intentionally NOT produced here (v1 stub). The seam is `AssetTags.embedding?` staying `undefined`.

### Step 1 (red) — write `test/assets/ingest.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestAsset, tagAsset } from "../../src/assets/ingest.ts";
import { loadLibrary } from "../../src/assets/library.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

// A real 2x1 PNG (width=2, height=1) so dimension sniffing has something to read.
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR42mNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function tagsResponse(over: Record<string, unknown> = {}): ChatFn {
  const body = JSON.stringify({
    hasPeople: false,
    subjects: ["barbell"],
    activity: "lifting",
    mood: ["focused"],
    setting: "product",
    description: "A loaded barbell on a gym platform.",
    quality: "high",
    ...over,
  });
  return async (): Promise<ChatResponse> => ({
    content: body,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
}

function writeSrc(dir: string, name = "src.png", buf: Buffer = PNG_2x1): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

describe("ingestAsset", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("copies the file into library/, records a pending asset, and returns its id", async () => {
    const src = writeSrc(dir);
    const { assetId, tagging } = await ingestAsset(dir, {
      file: src,
      source: "upload",
      businessId: "biz_1",
      chat: tagsResponse(),
      model: "vision-test",
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(assetId).toMatch(/^ast_/);

    // The file landed under library/ with the right extension.
    const lib0 = loadLibrary(dir, "biz_1");
    const rec = lib0.assets[assetId];
    expect(rec.file).toBe(`library/${assetId}.png`);
    expect(fs.existsSync(path.join(dir, rec.file))).toBe(true);

    // Sniffed metadata.
    expect(rec.mime).toBe("image/png");
    expect(rec.dimensions).toEqual({ w: 2, h: 1 });
    expect(rec.bytes).toBe(PNG_2x1.length);
    expect(rec.source).toBe("upload");
    expect(rec.status).toBe("active");
    expect(rec.createdAt).toBe("2026-08-02T12:00:00.000Z");

    // Before tagging finishes, tags are pending.
    // (loadLibrary above may already reflect completion depending on timing, so assert on the
    //  persisted-at-ingest snapshot via the returned promise below.)

    await tagging;

    // After tagging, tags land in library.json.
    const lib1 = loadLibrary(dir, "biz_1");
    const tagged = lib1.assets[assetId];
    expect(tagged.tags.pending).toBe(false);
    expect(tagged.tags.subjects).toContain("barbell");
    expect(tagged.tags.setting).toBe("product");
    expect(tagged.tags.quality).toBe("high");
    expect(tagged.tags.embedding).toBeUndefined(); // v1 stub
  });

  it("derives aspectRatio 'other' for a 2x1 image", async () => {
    const src = writeSrc(dir);
    const { assetId, tagging } = await ingestAsset(dir, { file: src, source: "upload", businessId: "biz_1", chat: tagsResponse(), model: "m" });
    await tagging;
    expect(loadLibrary(dir, "biz_1").assets[assetId].aspectRatio).toBe("other");
  });

  it("leaves tags pending when no chat/model is provided (tagging is a no-op)", async () => {
    const src = writeSrc(dir);
    const { assetId, tagging } = await ingestAsset(dir, { file: src, source: "upload", businessId: "biz_1" });
    await tagging;
    expect(loadLibrary(dir, "biz_1").assets[assetId].tags.pending).toBe(true);
  });

  it("throws on an unrecognized file header (never catalogs an unmeasurable file)", async () => {
    const bad = writeSrc(dir, "bad.bin", Buffer.from("not-an-image"));
    await expect(ingestAsset(dir, { file: bad, source: "upload", businessId: "biz_1" })).rejects.toThrow(/sniff|header|image/i);
  });

  it("appends to an existing library rather than replacing it", async () => {
    const a = await ingestAsset(dir, { file: writeSrc(dir, "a.png"), source: "upload", businessId: "biz_1", chat: tagsResponse(), model: "m" });
    await a.tagging;
    const b = await ingestAsset(dir, { file: writeSrc(dir, "b.png"), source: "generated", businessId: "biz_1", chat: tagsResponse(), model: "m" });
    await b.tagging;
    const lib = loadLibrary(dir, "biz_1");
    expect(Object.keys(lib.assets)).toHaveLength(2);
  });
});

describe("tagAsset", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "tag-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("sends the image as a vision message and writes the returned tags", async () => {
    // Ingest without a tagger so the record stays pending.
    const src = writeSrc(dir);
    const { assetId } = await ingestAsset(dir, { file: src, source: "upload", businessId: "biz_1" });
    expect(loadLibrary(dir, "biz_1").assets[assetId].tags.pending).toBe(true);

    // Capture the vision message the tagger sends.
    let seenImage = false;
    const chat: ChatFn = async (opts) => {
      const last = opts.messages[opts.messages.length - 1];
      if (Array.isArray(last.content)) {
        seenImage = last.content.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,"));
      }
      return { content: JSON.stringify({ hasPeople: false, subjects: ["kettlebell"], mood: [], setting: "product", description: "A kettlebell.", quality: "medium" }), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    };

    await tagAsset(dir, assetId, { chat, model: "vision-test" });
    expect(seenImage).toBe(true);
    const rec = loadLibrary(dir, "biz_1").assets[assetId];
    expect(rec.tags.pending).toBe(false);
    expect(rec.tags.subjects).toEqual(["kettlebell"]);
  });

  it("forces hasPeople:false onto a GENERATED asset even if the model claims otherwise", async () => {
    // Safety invariant: the engine never generates people, so a generated asset can't be hasPeople.
    const src = writeSrc(dir);
    const { assetId } = await ingestAsset(dir, { file: src, source: "generated", businessId: "biz_1" });
    const chat = tagsResponseWithPeople();
    await tagAsset(dir, assetId, { chat, model: "m" });
    expect(loadLibrary(dir, "biz_1").assets[assetId].tags.hasPeople).toBe(false);
  });
});

function tagsResponseWithPeople(): ChatFn {
  return async (): Promise<ChatResponse> => ({
    content: JSON.stringify({ hasPeople: true, subjects: ["person"], mood: [], setting: "interior", description: "A coach.", quality: "high" }),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
}
```

Run — expect FAIL (module missing):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/ingest.test.ts
```

### Step 2 (green) — write `src/assets/ingest.ts`

```ts
/**
 * ingest.ts — bring an image into the Asset Library.
 *
 * ingestAsset copies a source file into `<businessDir>/library/`, sniffs its mime + dimensions,
 * creates an Asset record with `tags.pending:true`, persists it, then FIRES async CV tagging.
 * tagAsset performs the Claude-vision call that fills AssetTags and updates the record in place.
 *
 * Storage split of responsibility:
 *   - the library file (library.json) + the catalogued copy (library/ast_x.png) live here;
 *   - PLACING the asset on the site (assets/ + astro/public/assets/ + ref rewrites) is swapAsset,
 *     invoked by placeAsset (T3) — ingest never touches the rendered site.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { llmJson } from "@milo/llm";
import type { ChatFn, ChatMessage } from "@milo/llm";
import {
  loadLibrary,
  saveLibrary,
  addAsset,
  updateAssetTags,
  getAsset,
  type Asset,
  type AssetLibrary,
  type AssetTags,
} from "./library.ts";

export interface IngestOpts {
  file: string;
  source: "upload" | "generated";
  businessId?: string;
  brief?: string;
  altText?: string;
  chat?: ChatFn;
  model?: string;
  now?: () => Date;
}

export interface IngestResult {
  assetId: string;
  library: AssetLibrary;
  /** In-flight (or already-resolved) CV-tagging promise. Callers may await it or ignore it. */
  tagging: Promise<void>;
}

// --- mime + dimension sniffing (PNG / JPEG / WebP / GIF) ------------------------------------

interface Sniffed { mime: string; w: number; h: number; ext: string; }

function sniffImage(buf: Buffer): Sniffed {
  // PNG: \x89PNG\r\n\x1a\n then IHDR (width/height big-endian at bytes 16..24).
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") {
    return { mime: "image/png", ext: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a", little-endian width/height at bytes 6..10.
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF") {
    return { mime: "image/gif", ext: "gif", w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // WebP: "RIFF"...."WEBP" + a VP8/VP8L/VP8X chunk.
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp", ...webpDimensions(buf) };
  }
  // JPEG: 0xFFD8, then walk SOF markers for dimensions.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { mime: "image/jpeg", ext: "jpg", ...jpegDimensions(buf) };
  }
  throw new Error("ingestAsset: could not sniff image header (supported: PNG, JPEG, WebP, GIF)");
}

function webpDimensions(buf: Buffer): { w: number; h: number } {
  const fourcc = buf.toString("latin1", 12, 16);
  if (fourcc === "VP8 ") {
    // Lossy: 16-bit width/height (14 bits used) at offset 26.
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    // Lossless: 14-bit width/height packed after the 0x2f signature at offset 21.
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8X") {
    // Extended: 24-bit (value+1) width/height at offset 24.
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { w, h };
  }
  throw new Error("ingestAsset: unrecognized WebP chunk");
}

function jpegDimensions(buf: Buffer): { w: number; h: number } {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    // SOF0..SOF15 (except 0xC4/0xC8/0xCC which are not frame headers) carry dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  throw new Error("ingestAsset: could not read JPEG dimensions");
}

function aspectRatioOf(w: number, h: number): Asset["aspectRatio"] {
  if (h === 0) return "other";
  const r = w / h;
  const near = (target: number) => Math.abs(r - target) < 0.02;
  if (near(16 / 9)) return "16:9";
  if (near(1)) return "1:1";
  if (near(4 / 3)) return "4:3";
  if (near(3 / 2)) return "3:2";
  return "other";
}

function pendingTags(): AssetTags {
  return { pending: true, hasPeople: false, subjects: [], mood: [], setting: "product", description: "", quality: "medium" };
}

// --- ingest --------------------------------------------------------------------------------

export async function ingestAsset(businessDir: string, opts: IngestOpts): Promise<IngestResult> {
  const buf = fs.readFileSync(opts.file);
  const sniffed = sniffImage(buf);

  const id = `ast_${crypto.randomUUID()}`;
  const rel = `library/${id}.${sniffed.ext}`;
  const dest = path.join(businessDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);

  const now = (opts.now ?? (() => new Date()))();
  const asset: Asset = {
    id,
    source: opts.source,
    file: rel,
    mime: sniffed.mime,
    dimensions: { w: sniffed.w, h: sniffed.h },
    aspectRatio: aspectRatioOf(sniffed.w, sniffed.h),
    bytes: buf.length,
    tags: pendingTags(),
    ...(opts.altText !== undefined ? { altText: opts.altText } : {}),
    usages: [],
    status: "active",
    createdAt: now.toISOString(),
  };

  const businessId = opts.businessId ?? loadLibrary(businessDir, "biz_unknown").businessId;
  const library = addAsset(loadLibrary(businessDir, businessId), asset);
  saveLibrary(businessDir, library);

  // Fire async CV tagging. If no chat/model, tagging is a resolved no-op (record stays pending).
  const tagging =
    opts.chat && opts.model
      ? tagAsset(businessDir, id, { chat: opts.chat, model: opts.model, brief: opts.brief })
      : Promise.resolve();

  return { assetId: id, library, tagging };
}

// --- tagAsset ------------------------------------------------------------------------------

const AssetTagsSchema = z.object({
  hasPeople: z.boolean(),
  subjects: z.array(z.string()),
  activity: z.string().optional(),
  mood: z.array(z.string()),
  setting: z.enum(["interior", "exterior", "studio", "abstract", "food", "product"]),
  description: z.string(),
  quality: z.enum(["low", "medium", "high"]),
  qualityNotes: z.array(z.string()).optional(),
});

const TAG_SYSTEM = `You are a computer-vision tagger for a gym-website media library. Look at the image and return STRICT JSON:
- hasPeople: true if any recognizable human (face, body, hands) appears.
- subjects: concrete nouns in frame (e.g. "barbell", "kettlebell", "squat rack", "salad bowl").
- activity: one of "lifting" | "coaching" | "stretching" | "eating" | omit if none.
- mood: evocative adjectives ("energetic", "welcoming", "focused", "calm").
- setting: "interior" | "exterior" | "studio" | "abstract" | "food" | "product".
- description: ONE sentence describing the image (this becomes a search embedding).
- quality: "low" | "medium" | "high" (sharpness, lighting, composition, resolution).
- qualityNotes: optional issues, e.g. ["blurry", "overexposed", "low-resolution"].
Return ONLY the JSON object. No markdown.`;

export interface TagOpts { chat: ChatFn; model: string; brief?: string; }

export async function tagAsset(businessDir: string, assetId: string, opts: TagOpts): Promise<void> {
  const lib0 = loadLibrary(businessDir, "biz_unknown");
  const asset = getAsset(lib0, assetId);
  if (!asset) throw new Error(`tagAsset: unknown asset id: ${assetId}`);

  const buf = fs.readFileSync(path.join(businessDir, asset.file));
  const dataUri = `data:${asset.mime};base64,${buf.toString("base64")}`;

  const messages: ChatMessage[] = [
    { role: "system", content: TAG_SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: opts.brief ? `Context (generation brief): ${opts.brief}` : "Tag this image." },
        { type: "image_url", image_url: { url: dataUri } },
      ],
    },
  ];

  const raw = await llmJson(AssetTagsSchema, { chat: opts.chat, model: opts.model, messages, temperature: 0 });

  // Safety invariant: a GENERATED asset can never contain real people — the engine refuses to
  // generate them. Force hasPeople:false so a mis-tag can't route a generated image into
  // people-requiring slots. (See safety.ts for the authenticity rationale.)
  const hasPeople = asset.source === "generated" ? false : raw.hasPeople;

  const tags: AssetTags = {
    pending: false,
    hasPeople,
    subjects: raw.subjects,
    ...(raw.activity !== undefined ? { activity: raw.activity } : {}),
    mood: raw.mood,
    setting: raw.setting,
    description: raw.description,
    quality: raw.quality,
    ...(raw.qualityNotes !== undefined ? { qualityNotes: raw.qualityNotes } : {}),
    // embedding: intentionally omitted (v1 stub — findAsset falls back to recency).
  };

  // Re-load before writing so a concurrent tag of a DIFFERENT asset isn't clobbered.
  const fresh = loadLibrary(businessDir, lib0.businessId);
  saveLibrary(businessDir, updateAssetTags(fresh, assetId, tags));
}
```

Run — expect PASS + tsc clean:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/ingest.test.ts
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```

### Commit T1
```bash
git add packages/clone-engine/src/assets/ingest.ts packages/clone-engine/test/assets/ingest.test.ts
git commit -m "feat(assets): ingest + Claude-vision CV tagging into the library (T1)"
```

---

## T2 — `find.ts`: pure ranked query

**Files:**
- CREATE `src/assets/find.ts`
- CREATE `test/assets/find.test.ts`

**What it does:** `findAsset(library, query)` — a **pure** function (no I/O, no network). Filters `status:"active"` assets by the query's **hard constraints**, then **ranks**:
- If the query carries an `embedding` AND candidates have embeddings → cosine similarity (descending).
- Otherwise → recency (`createdAt` descending).

`findAsset` is NOT an EditOp — it's the read-only "choose an asset" step an agent runs before `placeAsset`.

**Query shape:**
```ts
export interface FindQuery {
  aspectRatio?: Asset["aspectRatio"];           // hard filter
  setting?: AssetTags["setting"];               // hard filter
  hasPeople?: boolean;                          // hard filter (usually false)
  usableContext?: "generated-safe" | "any";     // "generated-safe" ⇒ exclude hasPeople assets
  minQuality?: "low" | "medium" | "high";       // hard filter (>= threshold)
  embedding?: number[];                         // ranking signal
  limit?: number;                               // cap results (default: all)
}
```

`usableContext:"generated-safe"` is the slot-safety filter: a slot that would otherwise be filled by generation (equipment/food/texture) must only receive assets without people, mirroring the generation gate.

### Step 1 (red) — write `test/assets/find.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { findAsset } from "../../src/assets/find.ts";
import { emptyLibrary, addAsset, type Asset, type AssetLibrary, type AssetTags } from "../../src/assets/library.ts";

function tags(over: Partial<AssetTags> = {}): AssetTags {
  return { pending: false, hasPeople: false, subjects: [], mood: [], setting: "product", description: "", quality: "high", ...over };
}

function asset(id: string, over: Partial<Asset> = {}, tagOver: Partial<AssetTags> = {}): Asset {
  return {
    id, source: "upload", file: `library/${id}.webp`, mime: "image/webp",
    dimensions: { w: 1600, h: 900 }, aspectRatio: "16:9", bytes: 100,
    tags: tags(tagOver), usages: [], status: "active", createdAt: "2026-08-01T00:00:00.000Z", ...over,
  };
}

function libOf(...assets: Asset[]): AssetLibrary {
  return assets.reduce((lib, a) => addAsset(lib, a), emptyLibrary("biz_1"));
}

describe("findAsset — hard filters", () => {
  it("excludes archived assets", () => {
    const lib = libOf(asset("ast_a", { status: "archived" }), asset("ast_b"));
    expect(findAsset(lib, {}).map((a) => a.id)).toEqual(["ast_b"]);
  });

  it("filters by aspectRatio", () => {
    const lib = libOf(asset("ast_wide", { aspectRatio: "16:9" }), asset("ast_sq", { aspectRatio: "1:1" }));
    expect(findAsset(lib, { aspectRatio: "1:1" }).map((a) => a.id)).toEqual(["ast_sq"]);
  });

  it("filters by setting", () => {
    const lib = libOf(asset("ast_food", {}, { setting: "food" }), asset("ast_prod", {}, { setting: "product" }));
    expect(findAsset(lib, { setting: "food" }).map((a) => a.id)).toEqual(["ast_food"]);
  });

  it("filters by hasPeople", () => {
    const lib = libOf(asset("ast_people", {}, { hasPeople: true }), asset("ast_clean", {}, { hasPeople: false }));
    expect(findAsset(lib, { hasPeople: false }).map((a) => a.id)).toEqual(["ast_clean"]);
  });

  it("usableContext 'generated-safe' excludes any hasPeople asset", () => {
    const lib = libOf(asset("ast_people", {}, { hasPeople: true }), asset("ast_clean", {}, { hasPeople: false }));
    expect(findAsset(lib, { usableContext: "generated-safe" }).map((a) => a.id)).toEqual(["ast_clean"]);
  });

  it("minQuality keeps assets at or above the threshold", () => {
    const lib = libOf(asset("ast_low", {}, { quality: "low" }), asset("ast_med", {}, { quality: "medium" }), asset("ast_high", {}, { quality: "high" }));
    expect(findAsset(lib, { minQuality: "medium" }).map((a) => a.id).sort()).toEqual(["ast_high", "ast_med"]);
  });
});

describe("findAsset — ranking", () => {
  it("ranks by recency when no embedding is available", () => {
    const older = asset("ast_old", { createdAt: "2026-08-01T00:00:00.000Z" });
    const newer = asset("ast_new", { createdAt: "2026-08-02T00:00:00.000Z" });
    const lib = libOf(older, newer);
    expect(findAsset(lib, {}).map((a) => a.id)).toEqual(["ast_new", "ast_old"]);
  });

  it("ranks by cosine similarity when the query and candidates have embeddings", () => {
    const q = { embedding: [1, 0, 0] };
    const near = asset("ast_near", { createdAt: "2026-08-01T00:00:00.000Z" }, { embedding: [0.9, 0.1, 0] });
    const far = asset("ast_far", { createdAt: "2026-08-02T00:00:00.000Z" }, { embedding: [0, 0, 1] });
    const lib = libOf(near, far);
    // Recency would put ast_far first; cosine must put ast_near first.
    expect(findAsset(lib, q).map((a) => a.id)).toEqual(["ast_near", "ast_far"]);
  });

  it("falls back to recency for candidates missing an embedding even when the query has one", () => {
    const q = { embedding: [1, 0, 0] };
    const a = asset("ast_a", { createdAt: "2026-08-01T00:00:00.000Z" }); // no embedding
    const b = asset("ast_b", { createdAt: "2026-08-02T00:00:00.000Z" }); // no embedding
    const lib = libOf(a, b);
    expect(findAsset(lib, q).map((x) => x.id)).toEqual(["ast_b", "ast_a"]);
  });

  it("respects limit", () => {
    const lib = libOf(asset("ast_a"), asset("ast_b"), asset("ast_c"));
    expect(findAsset(lib, { limit: 2 })).toHaveLength(2);
  });

  it("returns [] when nothing matches", () => {
    const lib = libOf(asset("ast_a", {}, { setting: "product" }));
    expect(findAsset(lib, { setting: "food" })).toEqual([]);
  });
});
```

Run — expect FAIL:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/find.test.ts
```

### Step 2 (green) — write `src/assets/find.ts`

```ts
/**
 * find.ts — pure ranked retrieval over the Asset Library.
 *
 * findAsset is a PURE query (no I/O, no network): it hard-filters active assets against the
 * query's constraints, then ranks by cosine similarity (when embeddings are present on BOTH the
 * query and the candidates) or by recency otherwise. It is deliberately NOT an EditOp — it's the
 * read-only "choose an asset" step an agent runs before placeAsset/uploadAsset.
 */
import type { Asset, AssetLibrary, AssetTags } from "./library.ts";

export interface FindQuery {
  aspectRatio?: Asset["aspectRatio"];
  setting?: AssetTags["setting"];
  hasPeople?: boolean;
  usableContext?: "generated-safe" | "any";
  minQuality?: "low" | "medium" | "high";
  embedding?: number[];
  limit?: number;
}

const QUALITY_RANK: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };

function passesFilters(a: Asset, q: FindQuery): boolean {
  if (a.status !== "active") return false;
  if (q.aspectRatio !== undefined && a.aspectRatio !== q.aspectRatio) return false;
  if (q.setting !== undefined && a.tags.setting !== q.setting) return false;
  if (q.hasPeople !== undefined && a.tags.hasPeople !== q.hasPeople) return false;
  if (q.usableContext === "generated-safe" && a.tags.hasPeople) return false;
  if (q.minQuality !== undefined && QUALITY_RANK[a.tags.quality] < QUALITY_RANK[q.minQuality]) return false;
  return true;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function findAsset(library: AssetLibrary, query: FindQuery): Asset[] {
  const candidates = Object.values(library.assets).filter((a) => passesFilters(a, query));

  const useEmbedding =
    query.embedding !== undefined && candidates.every((a) => a.tags.embedding !== undefined);

  const ranked = candidates.slice().sort((x, y) => {
    if (useEmbedding) {
      const sx = cosine(query.embedding!, x.tags.embedding!);
      const sy = cosine(query.embedding!, y.tags.embedding!);
      if (sx !== sy) return sy - sx; // higher similarity first
    }
    // Recency (createdAt descending). ISO strings sort lexicographically.
    if (x.createdAt !== y.createdAt) return x.createdAt < y.createdAt ? 1 : -1;
    return x.id < y.id ? -1 : 1; // stable tiebreak
  });

  return query.limit !== undefined ? ranked.slice(0, query.limit) : ranked;
}
```

Run — expect PASS + tsc clean:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/find.test.ts
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```

### Commit T2
```bash
git add packages/clone-engine/src/assets/find.ts packages/clone-engine/test/assets/find.test.ts
git commit -m "feat(assets): pure ranked findAsset query (T2)"
```

---

## T3 — `placeAsset` EditOp: wire into the edit surfaces

**Files:**
- EDIT `src/edit/types.ts` — add `placeAsset` to `EditOp` union + `EditOpSchema`.
- EDIT `src/edit/apply.ts` — add dispatch case + `targetIdentity` case + import.
- EDIT `src/edit/plan.ts` — add `validateOpTarget` case + a line to `SYSTEM_PROMPT`.
- CREATE `src/edit/place.ts` — the `placeAsset` op implementation (kept out of the giant `ops.ts`).
- CREATE `test/assets/place-op-wiring.test.ts` — schema + plan-validation wiring tests.

**What it does:** `placeAsset(site, alias, assetId)`:
1. `loadLibrary(site.dir, …)` → `getAsset(library, assetId)`; if missing/archived → throw a `TargetError`.
2. `swapAsset(site, alias, path.join(site.dir, asset.file))` — the existing primitive does storage + ref rewrites + `site.json` update. Its `OpResult.targetSections` tells us where it landed.
3. Stamp `assetId` onto the matching `site.json` asset entry (so the site remembers which library asset backs the alias).
4. For each `targetSection`, `recordUsage(library, assetId, { alias, route, section })`; `saveLibrary`.
5. Return `swapAsset`'s `OpResult` (so `buildIntent` treats it exactly like a swap for the verifier — same rollback oracle).

**Op shape:** `{ op: "placeAsset"; alias: string; assetId: string }`.

### Step 1 (red) — write `test/assets/place-op-wiring.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditOpSchema } from "../../src/edit/types.ts";
import { plan } from "../../src/edit/plan.ts";
import { placeAsset } from "../../src/edit/place.ts";
import { emptyLibrary, addAsset, saveLibrary, loadLibrary, type Asset } from "../../src/assets/library.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function libAsset(id: string): Asset {
  return {
    id, source: "upload", file: `library/${id}.png`, mime: "image/png",
    dimensions: { w: 1, h: 1 }, aspectRatio: "1:1", bytes: PNG_1x1.length,
    tags: { pending: false, hasPeople: false, subjects: ["barbell"], mood: [], setting: "product", description: "A barbell.", quality: "high" },
    usages: [], status: "active", createdAt: "2026-08-02T00:00:00.000Z",
  };
}

function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "place-"));
  const publicAssets = path.join(dir, "astro", "public", "assets");
  const rootAssets = path.join(dir, "assets");
  const components = path.join(dir, "astro", "src", "components");
  const lib = path.join(dir, "library");
  for (const d of [publicAssets, rootAssets, components, lib]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(publicAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(rootAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(lib, "ast_new.png"), PNG_1x1);
  fs.writeFileSync(path.join(components, "HeroSection.astro"), `---\nconst content = [];\n---\n<section data-component="HeroSection"><img src="/assets/a1.png" /></section>\n`);
  fs.writeFileSync(path.join(dir, "astro", "brand.json"), JSON.stringify({ colors: { primary: { hex: "#000", value: "rgb(0,0,0)", variants: {} }, accent: { hex: "#111", value: "rgb(17,17,17)", variants: {} }, surface: { hex: "#fff", value: "rgb(255,255,255)", variants: {} }, text: { hex: "#222", value: "rgb(34,34,34)", variants: {} }, muted: { hex: "#888", value: "rgb(136,136,136)", variants: {} } }, space: {}, radius: {} }));
  const manifest = { pages: [{ route: "/", component: "HomePage", type: "home", goal: "trust", sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }], elements: [], assets: [{ alias: "hero-image", file: "assets/a1.png" }], copy: [] }] };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  saveLibrary(dir, addAsset(emptyLibrary("biz_1"), libAsset("ast_new")));
  return { dir };
}

function fakeChat(json: string): ChatFn {
  return async (): Promise<ChatResponse> => ({ content: json, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
}

describe("EditOpSchema — placeAsset", () => {
  it("accepts a valid placeAsset op", () => {
    const parsed = EditOpSchema.parse({ op: "placeAsset", alias: "hero-image", assetId: "ast_new" });
    expect(parsed).toEqual({ op: "placeAsset", alias: "hero-image", assetId: "ast_new" });
  });
  it("rejects a placeAsset op missing assetId", () => {
    expect(() => EditOpSchema.parse({ op: "placeAsset", alias: "hero-image" })).toThrow();
  });
});

describe("placeAsset (op impl)", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("swaps the file, stamps assetId onto site.json, and records the usage", async () => {
    const res = await placeAsset(site, "hero-image", "ast_new");
    expect(res.targetSections).toContain("HeroSection");

    // site.json asset entry now carries assetId.
    const manifest = JSON.parse(fs.readFileSync(path.join(site.dir, "site.json"), "utf8"));
    const entry = manifest.pages[0].assets.find((a: { alias: string }) => a.alias === "hero-image");
    expect(entry.assetId).toBe("ast_new");

    // library usage recorded.
    const lib = loadLibrary(site.dir, "biz_1");
    expect(lib.assets["ast_new"].usages).toEqual([{ alias: "hero-image", route: "/", section: "HeroSection" }]);
  });

  it("throws a TargetError for an unknown assetId", async () => {
    await expect(placeAsset(site, "hero-image", "ast_missing")).rejects.toThrow(/ast_missing/);
  });

  it("throws for an archived assetId", async () => {
    // archive it first
    const { archiveAsset } = await import("../../src/assets/library.ts");
    saveLibrary(site.dir, archiveAsset(loadLibrary(site.dir, "biz_1"), "ast_new"));
    await expect(placeAsset(site, "hero-image", "ast_new")).rejects.toThrow(/archived/i);
  });
});

describe("plan validates placeAsset", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("keeps a placeAsset op whose alias + assetId both exist", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "place library asset", ops: [{ op: "placeAsset", alias: "hero-image", assetId: "ast_new" }] }));
    const result = await plan(site, [{ role: "user", content: "put ast_new in the hero" }], chat, "m");
    expect(result.needsInfo).toBe(false);
    if (!result.needsInfo) expect(result.ops[0].op).toBe("placeAsset");
  });

  it("drops a placeAsset op whose assetId does NOT exist → needsInfo:true", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "bad", ops: [{ op: "placeAsset", alias: "hero-image", assetId: "ast_ghost" }] }));
    const result = await plan(site, [{ role: "user", content: "place a ghost" }], chat, "m");
    expect(result.needsInfo).toBe(true);
  });

  it("drops a placeAsset op whose alias does NOT exist → needsInfo:true", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "bad", ops: [{ op: "placeAsset", alias: "no-such-alias", assetId: "ast_new" }] }));
    const result = await plan(site, [{ role: "user", content: "place into nowhere" }], chat, "m");
    expect(result.needsInfo).toBe(true);
  });
});
```

Run — expect FAIL:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/place-op-wiring.test.ts
```

### Step 2 (green)

**2a — `src/edit/types.ts`: add to the union (after `generateAsset`).** Change the union's last member to add a comma and append:
```ts
  | { op: "generateAsset"; alias: string; brief: string; category?: SafeImageCategory; aspectRatio?: "16:9" | "1:1" | "4:3" } // safe AI image generation
  | { op: "placeAsset"; alias: string; assetId: string }                                    // place a library asset into a slot
  | { op: "uploadAsset"; file: string; alias: string; altText?: string };                   // owner-provided photo → library → slot
```
> Note: `uploadAsset` (T5) is added to the union here in T3 too, since a discriminated union is a single edit; its schema + dispatch land in T5. Adding the type now keeps the `targetIdentity` switch exhaustive after T3's addition. Alternatively add each in its own task — but the exhaustive-switch requirement (below) makes it cleanest to declare both union members here.

Add both to `EditOpSchema` (after the `generateAsset` object):
```ts
  z.object({ op: z.literal("placeAsset"), alias: z.string().min(1), assetId: z.string().min(1) }),
  z.object({ op: z.literal("uploadAsset"), file: z.string().min(1), alias: z.string().min(1), altText: z.string().optional() }),
```

**2b — `src/edit/place.ts`: the op implementation.**
```ts
/**
 * place.ts — placeAsset / uploadAsset ops: bridge the Asset Library to the rendered site.
 *
 * placeAsset resolves a library assetId to its catalogued file and hands it to the existing
 * swapAsset primitive (storage + ref rewrites + site.json update), then stamps `assetId` onto
 * the site.json asset entry and records the placement in the library's reverse-usage index.
 * It REUSES swapAsset verbatim so the verifier's rollback oracle sees an ordinary asset swap.
 */
import fs from "node:fs";
import path from "node:path";
import type { SiteRef, OpResult } from "./types.ts";
import type { SiteManifest } from "../types.ts";
import { swapAsset } from "./ops.ts";
import { TargetError } from "./target.ts";
import { loadLibrary, saveLibrary, getAsset, recordUsage } from "../assets/library.ts";

/** Place a catalogued library asset into a site slot (by alias). */
export async function placeAsset(site: SiteRef, alias: string, assetId: string): Promise<OpResult> {
  const library = loadLibrary(site.dir, "biz_unknown");
  const asset = getAsset(library, assetId);
  if (!asset) throw new TargetError(`placeAsset: asset id not in library: ${assetId}`);
  if (asset.status === "archived") throw new TargetError(`placeAsset: asset is archived: ${assetId}`);

  const absFile = path.join(site.dir, asset.file);
  const result = await swapAsset(site, alias, absFile);

  // Stamp assetId onto the matching site.json asset entry(ies) so the site remembers its backing.
  const manifestPath = path.join(site.dir, "site.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SiteManifest & {
    pages: Array<{ route: string; assets: Array<{ alias: string; file: string; assetId?: string }> }>;
  };
  const routes: string[] = [];
  for (const page of manifest.pages) {
    for (const a of page.assets) {
      if (a.alias === alias) { a.assetId = assetId; routes.push(page.route); }
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // Record one usage per (route × placed section).
  let updated = loadLibrary(site.dir, library.businessId);
  const route = routes[0] ?? "/";
  for (const section of result.targetSections) {
    updated = recordUsage(updated, assetId, { alias, route, section });
  }
  // If swapAsset couldn't attribute a section, still record the alias placement.
  if (result.targetSections.length === 0) {
    updated = recordUsage(updated, assetId, { alias, route, section: "" });
  }
  saveLibrary(site.dir, updated);

  // Return swapAsset's OpResult but relabel the op so history/verifier see placeAsset.
  return { op: { op: "placeAsset", alias, assetId }, changedFiles: result.changedFiles, targetSections: result.targetSections };
}
```

**2c — `src/edit/apply.ts`: dispatch + import + targetIdentity.**

Add the import near the other op imports (after the `generateAsset` import, line ~39):
```ts
import { placeAsset } from "./place.ts";
```

Add dispatch cases in `applyOpsDeterministically`'s switch (after the `generateAsset` case):
```ts
      case "placeAsset":
        results.push(await placeAsset(site, op.alias, op.assetId));
        break;
      case "uploadAsset": {
        // uploadAsset ingests the owner's file into the library, then places it. (Impl in T5.)
        const { uploadAsset } = await import("./place.ts");
        results.push(await uploadAsset(site, op.file, op.alias, { altText: op.altText, chat: opts.chat, model: opts.model }));
        break;
      }
```
> The `uploadAsset` dispatch references a function added in T5. To keep T3 green in isolation, either (a) land T5's `uploadAsset` stub in `place.ts` now, or (b) add only the `placeAsset` case in T3 and the `uploadAsset` case in T5. **Recommended:** add only `placeAsset` here in T3; add the `uploadAsset` case in T5 alongside its implementation. (This plan's T5 re-states the exact case to add.)

Add `targetIdentity` cases (the switch must stay exhaustive over the union). After the `generateAsset` case:
```ts
    case "placeAsset":
      return `placeAsset:${op.alias}`;
    case "uploadAsset":
      return `uploadAsset:${op.alias}`;
```
> Because T3 adds BOTH union members (see 2a note), both `targetIdentity` cases are added here so the exhaustive switch compiles. Their dispatch and full behavior for `uploadAsset` arrive in T5.

**2d — `src/edit/plan.ts`: validation + prompt.**

Add cases to `validateOpTarget`'s switch (after the `generateAsset` case):
```ts
    case "placeAsset": {
      resolveAsset(site, parsed.alias); // the slot alias must exist on the site
      const lib = loadLibrary(site.dir, "biz_unknown");
      const a = getAsset(lib, parsed.assetId);
      if (!a) throw new TargetError(`placeAsset: asset id not in library: ${parsed.assetId}`);
      if (a.status === "archived") throw new TargetError(`placeAsset: asset is archived: ${parsed.assetId}`);
      break;
    }

    case "uploadAsset":
      resolveAsset(site, parsed.alias); // the slot alias must exist; the file is validated at apply time
      break;
```

Add the imports at the top of `plan.ts`:
```ts
import { loadLibrary, getAsset } from "../assets/library.ts";
```

Add to `SYSTEM_PROMPT` (after the `generateAsset` block):
```
For PLACING AN EXISTING LIBRARY IMAGE into a slot use placeAsset:
  { op: "placeAsset", alias: "<existing asset alias>", assetId: "<ast_… id from the library>" }
  Use this INSTEAD of generateAsset when a suitable image already exists in the library.
```

Run — expect PASS + tsc clean:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/place-op-wiring.test.ts
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/
```
> The `test/edit/` run guards against regressions in the shared edit surfaces (schema, plan, apply, targetIdentity). All existing edit tests must stay green.

### Commit T3
```bash
git add packages/clone-engine/src/edit/types.ts packages/clone-engine/src/edit/apply.ts packages/clone-engine/src/edit/plan.ts packages/clone-engine/src/edit/place.ts packages/clone-engine/test/assets/place-op-wiring.test.ts
git commit -m "feat(assets): placeAsset EditOp — library asset → site slot (T3)"
```

---

## T4 — Refactor `generateAsset`: generate → ingest → place

**Files:**
- EDIT `src/assets/generate.ts` — after Flux download, `ingestAsset(...source:"generated"...)` → `placeAsset`.
- EDIT `src/assets/safety.ts` — update the v1-safety comment to the authenticity rationale.
- EDIT `test/assets/generate.test.ts` — assert a library entry was created; keep external behavior.

**What it does:** `generateAsset`'s external contract is unchanged (`{ ok, assetAlias, failures }`), but internally, after the tmp file is downloaded, it now:
1. `ingestAsset(site.dir, { file: tmpFile, source: "generated", brief, businessId, chat, model })` → `{ assetId }` (tags run async).
2. `placeAsset(site, alias, assetId)` instead of raw `swapAsset`.

To keep tests hermetic (no real Claude), `generateAsset` gains **optional** `chat?: ChatFn` + `model?: string` args threaded to `ingestAsset`. When omitted, tagging is a no-op (record stays `pending`) — the generated image is still catalogued and placed. `apply.ts`'s `generateAsset` call passes `opts.chat` + `opts.model` (already available in `ApplyOptions`).

**Safety comment update** (`safety.ts`, top-of-file block): replace the "v1 safety model: we TRUST the prompt" framing with:
```ts
/**
 * Authenticity safety model.
 *
 * AI image generation NEVER produces people or gym interiors — not because the model can't, but
 * because it MUST NOT for authenticity. A gym's real members know exactly what their gym floor
 * looks like and who trains there; a fake face or a fabricated interior is instantly recognizable
 * as fake and destroys trust with the very community the site is meant to serve. Equipment, food,
 * and textures are safe to generate because they are generic — a stock barbell reads as a barbell,
 * not as a lie about this specific gym. UNSAFE_PATTERNS enforces this at the brief level (refuse
 * before generating); HARD_NEGATIVES enforces it at the prompt level (steer the model away). Real
 * photos of real people/interiors enter the library ONLY as uploads (source:"upload").
 */
```

### Step 1 (red) — extend `test/assets/generate.test.ts`

Keep all existing cases. Add:
```ts
import { loadLibrary } from "../../src/assets/library.ts";

// … inside describe("generateAsset", …) …

it("catalogs the generated image in the library as source:'generated'", async () => {
  stubFetch({ imageUrl: "https://cdn.fal.ai/out/generated.png" });
  const result = await generateAsset(site, { alias: "hero-image", brief: "a competition kettlebell" });
  expect(result.ok).toBe(true);

  const lib = loadLibrary(site.dir, "biz_unknown");
  const ids = Object.keys(lib.assets);
  expect(ids).toHaveLength(1);
  const asset = lib.assets[ids[0]];
  expect(asset.source).toBe("generated");
  expect(asset.file).toMatch(/^library\/ast_.*\.png$/);
  // the placed slot recorded a usage
  expect(asset.usages.some((u) => u.alias === "hero-image")).toBe(true);
  // no chat/model wired in this test → tags stay pending, embedding absent
  expect(asset.tags.pending).toBe(true);
  expect(asset.tags.embedding).toBeUndefined();
});

it("still swaps the placed file into both asset dirs (external behavior unchanged)", async () => {
  stubFetch({ imageUrl: "https://cdn.fal.ai/out/x.png" });
  const result = await generateAsset(site, { alias: "hero-image", brief: "a barbell" });
  expect(result.ok).toBe(true);
  // the placed image is present in the public assets dir
  const publicDir = path.join(site.dir, "astro", "public", "assets");
  expect(fs.readdirSync(publicDir).some((n) => n.startsWith("a1"))).toBe(true);
});
```
> The fixture `makeFixtureSite` already writes `library/` implicitly via `ingestAsset` (it `mkdir`s the dir). No fixture change needed. If `placeAsset` requires `library.json` to pre-exist, it doesn't — `loadLibrary` returns an empty library and `ingestAsset` creates it. Ensure the fixture does NOT pre-seed `library.json` so the first `ingestAsset` creates it fresh.

Run — expect FAIL (no library entry yet):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/generate.test.ts
```

### Step 2 (green) — edit `src/assets/generate.ts`

Add imports:
```ts
import { ingestAsset } from "./ingest.ts";
import { placeAsset } from "../edit/place.ts";
import type { ChatFn } from "@milo/llm";
```

Extend `GenerateAssetArgs`:
```ts
export interface GenerateAssetArgs {
  alias: string;
  brief: string;
  category?: SafeImageCategory;
  aspectRatio?: "16:9" | "1:1" | "4:3";
  chat?: ChatFn;   // threaded to ingestAsset for async CV tagging (optional; tests omit it)
  model?: string;
}
```

Replace the download-and-swap block (currently `await swapAsset(site, alias, tmpFile)`) with generate → ingest → place:
```ts
  const tmpFile = path.join(os.tmpdir(), `gen-asset-img-${crypto.randomUUID()}`);
  try {
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    if (!imgRes.ok) return { ok: false, assetAlias: alias, failures: [`generateAsset: image download returned ${imgRes.status}`] };
    fs.writeFileSync(tmpFile, Buffer.from(await imgRes.arrayBuffer()));

    // Catalog the generated image in the library, then place it via the library-aware op.
    const { assetId } = await ingestAsset(site.dir, {
      file: tmpFile,
      source: "generated",
      brief,
      chat: args.chat,
      model: args.model,
    });
    await placeAsset(site, alias, assetId);
  } catch (err) {
    return { ok: false, assetAlias: alias, failures: [`generateAsset: ingest/place failed: ${(err as Error).message}`] };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
```
Remove the now-unused `swapAsset` import if nothing else references it (it doesn't — `placeAsset` is the only caller now within this file).

Update `apply.ts`'s `generateAsset` case to thread chat/model:
```ts
      case "generateAsset": {
        const genResult = await generateAsset(site, { alias: op.alias, brief: op.brief, category: op.category, aspectRatio: op.aspectRatio, chat: opts.chat, model: opts.model });
        if (!genResult.ok) throw new Error(`generateAsset failed: ${genResult.failures.join("; ")}`);
        results.push({ op, changedFiles: [], targetSections: [] });
        break;
      }
```

Apply the safety comment update in `src/assets/safety.ts` (prepend the authenticity block above the `SafeImageCategory` type).

Run — expect PASS + tsc clean:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/generate.test.ts test/assets/safety.test.ts
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```

### Commit T4
```bash
git add packages/clone-engine/src/assets/generate.ts packages/clone-engine/src/assets/safety.ts packages/clone-engine/src/edit/apply.ts packages/clone-engine/test/assets/generate.test.ts
git commit -m "refactor(assets): generateAsset → ingest into library → placeAsset; authenticity safety comment (T4)"
```

---

## T5 — `uploadAsset` EditOp: owner-facing "I have a photo, put it here"

**Files:**
- EDIT `src/edit/place.ts` — add `uploadAsset(site, file, alias, opts)`.
- EDIT `src/edit/apply.ts` — add the `uploadAsset` dispatch case (deferred from T3).
- CREATE `test/assets/upload-op.test.ts`.

> The union member + schema + `targetIdentity` + `validateOpTarget` for `uploadAsset` already landed in T3. T5 only adds the runtime behavior + dispatch.

**What it does:** `uploadAsset(site, file, alias, opts)`:
1. `ingestAsset(site.dir, { file, source: "upload", altText, chat, model })` → `{ assetId }`.
2. `placeAsset(site, alias, assetId)`.
3. Returns a `placeAsset`-shaped `OpResult` relabeled to `uploadAsset` so history/verifier attribute it correctly.

Uploads are the ONLY path for real people/interiors into the library (`source:"upload"`), consistent with the authenticity model.

### Step 1 (red) — write `test/assets/upload-op.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadAsset } from "../../src/edit/place.ts";
import { loadLibrary } from "../../src/assets/library.ts";
import { EditOpSchema } from "../../src/edit/types.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR42mNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function tagsChat(): ChatFn {
  return async (): Promise<ChatResponse> => ({
    content: JSON.stringify({ hasPeople: true, subjects: ["coach", "member"], mood: ["welcoming"], setting: "interior", description: "Two members training together.", quality: "high" }),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
}

function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
  for (const d of ["astro/public/assets", "assets", "astro/src/components"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, "astro/public/assets/a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "assets/a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "astro/src/components/HeroSection.astro"), `---\nconst content = [];\n---\n<section data-component="HeroSection"><img src="/assets/a1.png" /></section>\n`);
  const manifest = { pages: [{ route: "/", component: "HomePage", type: "home", goal: "trust", sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }], elements: [], assets: [{ alias: "hero-image", file: "assets/a1.png" }], copy: [] }] };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

describe("EditOpSchema — uploadAsset", () => {
  it("accepts a valid uploadAsset op", () => {
    const parsed = EditOpSchema.parse({ op: "uploadAsset", file: "/tmp/x.png", alias: "hero-image", altText: "our gym" });
    expect(parsed.op).toBe("uploadAsset");
  });
});

describe("uploadAsset (op impl)", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("ingests the owner's photo as source:'upload' and places it", async () => {
    const src = path.join(os.tmpdir(), `upload-src-${Date.now()}.png`);
    fs.writeFileSync(src, PNG_2x1);
    try {
      const res = await uploadAsset(site, src, "hero-image", { altText: "our members", chat: tagsChat(), model: "m" });
      expect(res.op.op).toBe("uploadAsset");
      expect(res.targetSections).toContain("HeroSection");

      const lib = loadLibrary(site.dir, "biz_unknown");
      const ids = Object.keys(lib.assets);
      expect(ids).toHaveLength(1);
      const asset = lib.assets[ids[0]];
      expect(asset.source).toBe("upload");
      expect(asset.altText).toBe("our members");
      expect(asset.usages.some((u) => u.alias === "hero-image")).toBe(true);
    } finally {
      fs.rmSync(src, { force: true });
    }
  });

  it("PRESERVES hasPeople:true for an uploaded photo (uploads are the only people path)", async () => {
    const src = path.join(os.tmpdir(), `upload-people-${Date.now()}.png`);
    fs.writeFileSync(src, PNG_2x1);
    try {
      const res = await uploadAsset(site, src, "hero-image", { chat: tagsChat(), model: "m" });
      const lib = loadLibrary(site.dir, "biz_unknown");
      const asset = lib.assets[Object.keys(lib.assets)[0]];
      // Wait for tagging by re-checking after the op (uploadAsset awaits tagging internally, see impl note).
      expect(asset.tags.hasPeople).toBe(true);
      expect(res.op.op).toBe("uploadAsset");
    } finally {
      fs.rmSync(src, { force: true });
    }
  });
});
```
> Impl note surfaced by the second test: `uploadAsset` must **await the tagging promise** before returning, so the owner-facing op reports a fully-tagged asset (unlike `generateAsset`, which fires tagging in the background). This is the one place we block on tagging — the owner just handed us a file and expects it classified.

Run — expect FAIL (no `uploadAsset` export):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/upload-op.test.ts
```

### Step 2 (green) — add `uploadAsset` to `src/edit/place.ts`

```ts
import type { ChatFn } from "@milo/llm";
import { ingestAsset } from "../assets/ingest.ts";

export interface UploadOpts { altText?: string; chat?: ChatFn; model?: string; }

/** Owner-facing: ingest a provided photo into the library (as an upload), then place it. */
export async function uploadAsset(
  site: SiteRef,
  file: string,
  alias: string,
  opts: UploadOpts = {},
): Promise<OpResult> {
  const { assetId, tagging } = await ingestAsset(site.dir, {
    file,
    source: "upload",
    altText: opts.altText,
    chat: opts.chat,
    model: opts.model,
  });
  // Owner-facing op: block on tagging so the caller sees a fully-classified asset.
  await tagging;
  const result = await placeAsset(site, alias, assetId);
  return { op: { op: "uploadAsset", file, alias, ...(opts.altText !== undefined ? { altText: opts.altText } : {}) }, changedFiles: result.changedFiles, targetSections: result.targetSections };
}
```

Add the deferred `uploadAsset` dispatch case in `src/edit/apply.ts` (after the `placeAsset` case):
```ts
      case "uploadAsset":
        results.push(await uploadAsset(site, op.file, op.alias, { altText: op.altText, chat: opts.chat, model: opts.model }));
        break;
```
Add the import next to `placeAsset`:
```ts
import { placeAsset, uploadAsset } from "./place.ts";
```
(Replace the T3 `import { placeAsset } from "./place.ts";` line.)

Run — expect PASS + tsc clean + edit-suite regression check:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/upload-op.test.ts
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/
```

### Commit T5
```bash
git add packages/clone-engine/src/edit/place.ts packages/clone-engine/src/edit/apply.ts packages/clone-engine/test/assets/upload-op.test.ts
git commit -m "feat(assets): uploadAsset EditOp — owner photo → library → slot (T5)"
```

---

## T6 — `migrate.ts`: back-fill the library from an existing `site.json`

**Files:**
- CREATE `src/assets/migrate.ts`
- CREATE `test/assets/migrate.test.ts`

**What it does:** `migrateExistingAssets(businessDir, site)` walks every `site.json` asset entry across all pages, and for each entry that lacks an `assetId`:
1. Reads the referenced file (`<businessDir>/<entry.file>`).
2. `ingestAsset(businessDir, { file, source: "upload" })` — all pre-existing assets are treated as uploads (they were rehosted from a real site the owner controls). Tagging is a no-op unless a `chat`/`model` is passed.
3. Stamps `assetId` back onto the `site.json` entry AND records a usage (`alias`, `route`, and — best-effort — the section that references the file).
4. Idempotent: an entry that already has an `assetId` is skipped, so re-running is safe. De-dupes by `entry.file` so the same rehosted file shared across pages becomes ONE library asset with multiple usages.

Run once at startup or on first library access.

**Signature:**
```ts
export interface MigrateOpts { chat?: ChatFn; model?: string; businessId?: string; }
export interface MigrateResult { catalogued: number; skipped: number; assetIds: string[]; }
export async function migrateExistingAssets(businessDir: string, site: SiteRef, opts?: MigrateOpts): Promise<MigrateResult>;
```

### Step 1 (red) — write `test/assets/migrate.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateExistingAssets } from "../../src/assets/migrate.ts";
import { loadLibrary } from "../../src/assets/library.ts";
import type { SiteRef } from "../../src/edit/types.ts";

const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR42mNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function makeTwoPageSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  const assets = path.join(dir, "assets");
  const components = path.join(dir, "astro", "src", "components");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(components, { recursive: true });
  fs.writeFileSync(path.join(assets, "logo.png"), PNG_2x1);
  fs.writeFileSync(path.join(assets, "hero.png"), PNG_2x1);
  fs.writeFileSync(path.join(assets, "about.png"), PNG_2x1);
  fs.writeFileSync(path.join(components, "HeroSection.astro"), `<section data-component="HeroSection"><img src="/assets/hero.png" /><img src="/assets/logo.png" /></section>`);
  fs.writeFileSync(path.join(components, "AboutSection.astro"), `<section data-component="AboutSection"><img src="/assets/about.png" /><img src="/assets/logo.png" /></section>`);
  const manifest = {
    pages: [
      { route: "/", component: "HomePage", type: "home", goal: "trust",
        sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }],
        elements: [], copy: [],
        assets: [{ alias: "hero-image", file: "assets/hero.png" }, { alias: "logo", file: "assets/logo.png" }] },
      { route: "/about/", component: "AboutPage", type: "content", goal: "trust",
        sections: [{ name: "AboutSection", role: "content", file: "astro/src/components/AboutSection.astro", copyKeys: [], elementRoles: [] }],
        elements: [], copy: [],
        assets: [{ alias: "about-photo", file: "assets/about.png" }, { alias: "logo", file: "assets/logo.png" }] },
    ],
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

describe("migrateExistingAssets", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeTwoPageSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("catalogs every distinct referenced file as an upload and links assetId back into site.json", async () => {
    const res = await migrateExistingAssets(site.dir, site, { businessId: "biz_1" });

    // hero, about, logo → 3 distinct files (logo shared across pages counts once).
    expect(res.catalogued).toBe(3);
    const lib = loadLibrary(site.dir, "biz_1");
    expect(Object.keys(lib.assets)).toHaveLength(3);
    for (const a of Object.values(lib.assets)) expect(a.source).toBe("upload");

    // Every site.json asset entry now carries an assetId.
    const manifest = JSON.parse(fs.readFileSync(path.join(site.dir, "site.json"), "utf8"));
    for (const page of manifest.pages) for (const a of page.assets) expect(a.assetId).toMatch(/^ast_/);

    // The shared logo maps to ONE library asset used on both routes.
    const logoId = manifest.pages[0].assets.find((a: { alias: string }) => a.alias === "logo").assetId;
    expect(manifest.pages[1].assets.find((a: { alias: string }) => a.alias === "logo").assetId).toBe(logoId);
    expect(lib.assets[logoId].usages.map((u) => u.route).sort()).toEqual(["/", "/about/"]);
  });

  it("is idempotent — a second run catalogs nothing new", async () => {
    await migrateExistingAssets(site.dir, site, { businessId: "biz_1" });
    const again = await migrateExistingAssets(site.dir, site, { businessId: "biz_1" });
    expect(again.catalogued).toBe(0);
    expect(again.skipped).toBeGreaterThan(0);
    expect(Object.keys(loadLibrary(site.dir, "biz_1").assets)).toHaveLength(3);
  });
});
```

Run — expect FAIL:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/migrate.test.ts
```

### Step 2 (green) — write `src/assets/migrate.ts`

```ts
/**
 * migrate.ts — one-time back-fill of the Asset Library from an existing site.json.
 *
 * Every pre-existing rehosted asset is treated as an UPLOAD (the owner controls the real site it
 * came from). migrateExistingAssets walks site.json, ingests each DISTINCT referenced file once,
 * links the new assetId back onto every site.json entry that points at that file, and records a
 * usage per (route × referencing section). Idempotent: entries that already carry an assetId are
 * skipped, so it is safe to run at startup or on first library access.
 */
import fs from "node:fs";
import path from "node:path";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../edit/types.ts";
import type { SiteManifest } from "../types.ts";
import { ingestAsset } from "./ingest.ts";
import { loadLibrary, saveLibrary, recordUsage } from "./library.ts";

export interface MigrateOpts { chat?: ChatFn; model?: string; businessId?: string; }
export interface MigrateResult { catalogued: number; skipped: number; assetIds: string[]; }

type PageAsset = { alias: string; file: string; assetId?: string };
type MigratableManifest = SiteManifest & {
  pages: Array<{ route: string; assets: PageAsset[]; sections: Array<{ name: string; file: string }> }>;
};

/** Which section(s) on a page reference this asset file (best-effort, by src match). */
function sectionsReferencing(businessDir: string, page: MigratableManifest["pages"][number], relFile: string): string[] {
  const slash = `/${relFile}`;
  const names: string[] = [];
  for (const s of page.sections) {
    const p = path.join(businessDir, s.file);
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(slash)) names.push(s.name);
  }
  return names;
}

export async function migrateExistingAssets(businessDir: string, site: SiteRef, opts: MigrateOpts = {}): Promise<MigrateResult> {
  const manifestPath = path.join(businessDir, "site.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as MigratableManifest;
  const businessId = opts.businessId ?? "biz_unknown";

  const byFile = new Map<string, string>(); // relFile → assetId (dedupe shared files)
  const assetIds: string[] = [];
  let catalogued = 0;
  let skipped = 0;

  for (const page of manifest.pages) {
    for (const entry of page.assets) {
      if (entry.assetId) { skipped++; continue; } // already migrated

      let assetId = byFile.get(entry.file);
      if (!assetId) {
        const abs = path.join(businessDir, entry.file);
        const { assetId: newId, tagging } = await ingestAsset(businessDir, {
          file: abs, source: "upload", businessId, chat: opts.chat, model: opts.model,
        });
        await tagging; // migration runs to completion; safe because tests inject a mock or omit chat
        assetId = newId;
        byFile.set(entry.file, assetId);
        assetIds.push(assetId);
        catalogued++;
      }

      entry.assetId = assetId;

      // Record a usage per referencing section (fall back to a bare alias placement).
      let lib = loadLibrary(businessDir, businessId);
      const sections = sectionsReferencing(businessDir, page, entry.file);
      if (sections.length === 0) {
        lib = recordUsage(lib, assetId, { alias: entry.alias, route: page.route, section: "" });
      } else {
        for (const section of sections) lib = recordUsage(lib, assetId, { alias: entry.alias, route: page.route, section });
      }
      saveLibrary(businessDir, lib);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { catalogued, skipped, assetIds };
}
```

Run — expect PASS + tsc clean:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/migrate.test.ts
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```

### Commit T6
```bash
git add packages/clone-engine/src/assets/migrate.ts packages/clone-engine/test/assets/migrate.test.ts
git commit -m "feat(assets): migrate existing site.json assets into the library (T6)"
```

---

## T7 — Exports + full green + tsc clean

**Files:**
- EDIT `src/assets/index.ts` — export the library, ingest, find, migrate surfaces.
- EDIT `src/edit/index.ts` — export `placeAsset` + `uploadAsset` from `place.ts`.
- EDIT `src/index.ts` — nothing new needed (it re-exports `edit` and `assets` namespaces wholesale), but verify both new op functions are reachable via `edit` and the library via `assets`.
- CREATE `test/assets/exports.test.ts` — assert the public surface is reachable.

### Step 1 (red) — write `test/assets/exports.test.ts`

```ts
import { describe, it, expect } from "vitest";
import * as assets from "../../src/assets/index.ts";
import * as edit from "../../src/edit/index.ts";

describe("assets public surface", () => {
  it("exports the library CRUD", () => {
    for (const name of ["emptyLibrary", "loadLibrary", "saveLibrary", "addAsset", "getAsset", "updateAssetTags", "archiveAsset", "recordUsage"]) {
      expect(typeof (assets as Record<string, unknown>)[name]).toBe("function");
    }
  });
  it("exports ingest + tag", () => {
    expect(typeof assets.ingestAsset).toBe("function");
    expect(typeof assets.tagAsset).toBe("function");
  });
  it("exports findAsset", () => {
    expect(typeof assets.findAsset).toBe("function");
  });
  it("exports migrateExistingAssets", () => {
    expect(typeof assets.migrateExistingAssets).toBe("function");
  });
});

describe("edit public surface", () => {
  it("exports placeAsset + uploadAsset", () => {
    expect(typeof edit.placeAsset).toBe("function");
    expect(typeof edit.uploadAsset).toBe("function");
  });
});
```

Run — expect FAIL (exports not wired):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/exports.test.ts
```

### Step 2 (green) — wire the barrels

`src/assets/index.ts` — append:
```ts
export {
  emptyLibrary, loadLibrary, saveLibrary, addAsset, getAsset, updateAssetTags, archiveAsset, recordUsage,
} from "./library.ts";
export type { Asset, AssetTags, AssetUsage, AssetLibrary } from "./library.ts";
export { ingestAsset, tagAsset } from "./ingest.ts";
export type { IngestOpts, IngestResult, TagOpts } from "./ingest.ts";
export { findAsset } from "./find.ts";
export type { FindQuery } from "./find.ts";
export { migrateExistingAssets } from "./migrate.ts";
export type { MigrateOpts, MigrateResult } from "./migrate.ts";
```

`src/edit/index.ts` — append:
```ts
// Asset Library bridge ops (place a library asset / upload an owner photo into a slot).
export { placeAsset, uploadAsset } from "./place.ts";
export type { UploadOpts } from "./place.ts";
```

`src/index.ts` already re-exports `edit` and `assets` namespaces — no change needed. (Verify: `edit.placeAsset` and `assets.findAsset` are reachable through the top-level barrel via the existing `export * as edit` / `export * as assets` lines.)

Run — expect PASS:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/exports.test.ts
```

### Step 3 — full gate

```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```
Expected: entire suite green (all pre-existing + all 8 new asset-library suites), tsc exits 0.

### Commit T7
```bash
git add packages/clone-engine/src/assets/index.ts packages/clone-engine/src/edit/index.ts packages/clone-engine/test/assets/exports.test.ts
git commit -m "feat(assets): export asset-library surface; full suite green (T7)"
```

---

## Appendix — verified codebase facts (do not re-derive)

- **`swapAsset(site, alias, source)`** (`src/edit/ops.ts:315`) accepts a local path OR a URL, sniffs by magic bytes, writes to BOTH `<dir>/assets/` and `<dir>/astro/public/assets/`, rewrites `/assets/old`→`/assets/new` refs across `.astro` + `global.css`, updates `site.json` on a type change, and returns `{ op, changedFiles, targetSections }`. `placeAsset` MUST call it, never re-implement it.
- **`resolveAsset(site, alias)`** (`src/edit/target.ts:92`) throws `TargetError` when an alias is absent — the hallucination guard `plan.ts` relies on. `placeAsset`/`uploadAsset` validation reuses it for the slot alias.
- **`llmJson(schema, { chat, model, messages, temperature })`** (`@milo/llm`) is the schema-constrained LLM call. `ChatMessage.content` may be `ChatContentPart[]`; `{ type: "image_url", image_url: { url } }` carries a `data:` URI that the client base64-encodes for vision. Used by `tagAsset`.
- **`ChatFn`** (`@milo/llm`) is `(opts: ChatOptions) => Promise<ChatResponse>` — the injectable, mock-in-tests seam.
- **`ManifestAsset`** (`src/types.ts:159`) is `{ alias: string; file: string }`. This plan adds an optional `assetId?: string` to the on-disk asset entry (stamped by `placeAsset`/`migrate`); the `SiteManifest` interface may keep `ManifestAsset` as-is (the field is written and read structurally, tolerated by JSON round-trips) or be widened to `{ alias: string; file: string; assetId?: string }` for type-precision — widening is preferred and is a one-line edit in `src/types.ts`.
- **The rollback oracle** is an `editableHash` over editable files (`test/edit/apply.test.ts`). Because `placeAsset`/`uploadAsset` bottom out in `swapAsset` + JSON writes under `site.dir`, snapshot/restore covers them with no special handling.
- **`targetIdentity`** (`src/edit/apply.ts:406`) is an exhaustive `switch` over the `EditOp` union — adding a union member REQUIRES a matching case or tsc fails. This plan adds `placeAsset` and `uploadAsset` cases in T3.
- **Vitest**: `pnpm test` == `vitest run --no-file-parallelism`. Tests live in `test/assets/` (already exists, with `generate.test.ts` / `op-wiring.test.ts` / `safety.test.ts`). `tsc --noEmit` == `pnpm typecheck`.
- **Import specifiers** use the `.ts` extension throughout (ESM/repo convention) — e.g. `import { swapAsset } from "./ops.ts"`.
