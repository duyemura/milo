# generateAsset — Safe AI Image Generation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `generateAsset` edit op to the Milo clone engine that generates an on-brand, SAFE image via Flux (fal.ai), downloads it, and swaps it into the site through the existing `swapAsset` primitive. Safety is enforced entirely by prompt construction and a keyword classifier — no post-generation vision check (v1 decision). The op NEVER generates people, faces, bodies, workout poses, or identifiable gym interiors.

**Architecture:** `generateAsset` is a thin orchestrator over three deterministic pieces plus one HTTP call:
1. `classifyBrief(brief)` — pure heuristic keyword classifier → `SafeImageCategory`, or throws `UnsafeBriefError` when the brief demands people/bodies/identifiable interiors.
2. `buildPrompt(category, subject)` — pure prompt builder: `CATEGORY_TEMPLATES[category]` with `{subject}` filled + `HARD_NEGATIVES` appended.
3. Flux HTTP call to `https://fal.run/fal-ai/flux/dev` (mocked in all tests via `vi.stubGlobal('fetch', …)`).
4. Download the returned image URL to a tmp file → call the existing `swapAsset(site, alias, tmpFile)` (this IS the storage + manifest update) → clean up the tmp file.

The op plugs into the same surfaces as every other op: `EditOp` union + `EditOpSchema` (Zod) in `src/edit/types.ts`, the dispatch `switch` in `src/edit/apply.ts`, the barrel `src/index.ts` (via `src/edit/index.ts`), and the planner `SYSTEM_PROMPT` in `src/edit/plan.ts`. `generateAsset` reuses `swapAsset` verbatim — it does NOT reimplement asset storage, filename sniffing, ref rewriting, or manifest updates.

Because `swapAsset` already accepts a URL directly, the orchestrator could in principle hand the Flux URL straight to `swapAsset`. We DON'T — we download to a tmp file first so that (a) a rollback point is a real local file we control, (b) the fal.ai URL (which is ephemeral/signed) is not persisted anywhere, and (c) test mocking is a single `fetch` stub that covers both the Flux POST and the image GET. `swapAsset` then reads the local tmp file (its non-URL path), sniffs the type, and updates both storage dirs + `site.json`.

**Tech Stack:** Node 24 TypeScript, ESM (`.ts` import specifiers), Vitest, Zod. LLM helpers from `@milo/llm` are NOT needed — classification is a deterministic heuristic (`classifyBrief` is explicitly "no LLM needed" per the signature). `fetch` is the global Node fetch. No new dependencies.

**Key decisions already locked:**
- API: Flux via fal.ai, `POST https://fal.run/fal-ai/flux/dev`, `Authorization: Key ${FAL_API_KEY}`.
- Safety: trust prompt constraints for v1 — no post-gen classifier.
- Default aspect ratio: `16:9` (→ `image_size: "landscape_16_9"`).
- API key: `FAL_API_KEY` env var (not yet set; code reads it lazily so the module imports without it, and tests never need it because fetch is mocked).

---

## Commands (used throughout)

Run tests (scoped to the new suite):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/
```

Typecheck:
```bash
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```

Full edit suite (T3 gate) — the assets suite plus the ops/apply/plan tests the new op touches:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/ test/edit/
```

**Rules for every task:**
- Full TDD: write the failing test FIRST (red), confirm it fails for the RIGHT reason, then implement (green).
- NO real HTTP in any test — always `vi.stubGlobal('fetch', …)` and restore in `afterEach`/`vi.unstubAllGlobals()`.
- Commit each task with the EXACT `git add` paths listed. No `git add -A`.
- Import specifiers use the `.ts` extension (repo convention — see `src/edit/apply.ts`).

---

## T0 — safety.ts: categories, templates, buildPrompt, classifyBrief

**Files:**
- CREATE `src/assets/safety.ts`
- CREATE `src/assets/index.ts`
- CREATE `test/assets/safety.test.ts`

### T0 red — write the test first

CREATE `test/assets/safety.test.ts`:

```ts
/**
 * safety.test.ts — pure unit tests for the safe-image prompt layer (no API, no fs).
 *
 * Covers:
 *   - buildPrompt fills {subject} from the category template and ALWAYS appends the hard negatives.
 *   - classifyBrief maps representative keywords to the correct SafeImageCategory.
 *   - classifyBrief REFUSES people/body/identifiable-interior briefs by throwing UnsafeBriefError,
 *     and the error carries a safe alternative suggestion.
 */
import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  classifyBrief,
  UnsafeBriefError,
  HARD_NEGATIVES,
  CATEGORY_TEMPLATES,
  type SafeImageCategory,
} from "../../src/assets/safety.ts";

describe("buildPrompt", () => {
  it("fills {subject} into the category template", () => {
    const p = buildPrompt("equipment", "a competition kettlebell");
    expect(p).toContain("a competition kettlebell");
    // The literal placeholder must be gone.
    expect(p).not.toContain("{subject}");
    // It uses the equipment template's distinctive wording.
    expect(p).toContain("product photography");
  });

  it("ALWAYS appends the hard negatives verbatim", () => {
    for (const category of Object.keys(CATEGORY_TEMPLATES) as SafeImageCategory[]) {
      const p = buildPrompt(category, "something");
      expect(p).toContain(HARD_NEGATIVES);
      // The negatives must sit at the END (after the subject template).
      expect(p.endsWith(HARD_NEGATIVES)).toBe(true);
    }
  });

  it("HARD_NEGATIVES spells out the forbidden subjects", () => {
    for (const banned of ["no people", "no faces", "no bodies", "no hands", "no workout poses", "no gym interior", "no logos", "no text"]) {
      expect(HARD_NEGATIVES).toContain(banned);
    }
  });
});

describe("classifyBrief", () => {
  const cases: Array<[string, SafeImageCategory]> = [
    ["close-up of a barbell and weight plates", "equipment"],
    ["a rack of kettlebells", "equipment"],
    ["healthy meal prep containers", "food"],
    ["a protein shake on a counter", "food"],
    ["weathered concrete wall texture", "texture"],
    ["brushed metal surface pattern", "texture"],
    ["geometric architectural lighting detail", "architecture"],
    ["sunrise over a forest trail", "nature"],
    ["a generic water bottle product shot", "product"],
  ];

  for (const [brief, expected] of cases) {
    it(`classifies "${brief}" as ${expected}`, () => {
      expect(classifyBrief(brief)).toBe(expected);
    });
  }

  it("falls back to 'product' for an unrecognized-but-safe brief", () => {
    expect(classifyBrief("a nondescript object on a plain surface")).toBe("product");
  });
});

describe("classifyBrief refusals", () => {
  const unsafe = [
    "a person lifting weights",
    "photo of an athlete mid-workout",
    "smiling coach with members",
    "people doing burpees in the gym",
    "the interior of our CrossFit gym",
    "someone's face close up",
    "a body in a workout pose",
    "our team of trainers",
  ];

  for (const brief of unsafe) {
    it(`refuses "${brief}"`, () => {
      expect(() => classifyBrief(brief)).toThrow(UnsafeBriefError);
    });
  }

  it("attaches a safe alternative suggestion to the refusal", () => {
    try {
      classifyBrief("a person lifting weights");
      throw new Error("expected UnsafeBriefError");
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeBriefError);
      expect((e as UnsafeBriefError).suggestion).toBeTruthy();
      // The suggestion should point at a safe category (e.g. equipment) rather than people.
      expect((e as UnsafeBriefError).suggestion.toLowerCase()).toMatch(/equipment|texture|architecture/);
    }
  });
});
```

Run it — it MUST fail because `src/assets/safety.ts` does not exist yet:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/
```
Expected output: failure resolving `../../src/assets/safety.ts` (module not found). This is the correct red.

### T0 green — implement safety.ts

CREATE `src/assets/safety.ts`:

```ts
/**
 * safety.ts — the safe-image prompt layer for generateAsset.
 *
 * v1 safety model (decision): we TRUST the prompt. There is no post-generation vision
 * classifier. Two mechanisms keep the output safe:
 *
 *   1. classifyBrief() REFUSES any brief that asks for people, faces, bodies, workout poses,
 *      or identifiable gym interiors — throwing UnsafeBriefError with a safe-alternative
 *      suggestion BEFORE any API call is made.
 *   2. buildPrompt() constrains the request to one of six safe categories and ALWAYS appends
 *      HARD_NEGATIVES, which explicitly forbid people/faces/bodies/logos/text at generation time.
 *
 * Both functions are PURE (no I/O), so the whole safety surface is unit-testable without a
 * network call or a browser.
 */

/** The bounded set of subjects generateAsset is allowed to produce. */
export type SafeImageCategory =
  | "equipment"       // gym equipment close-ups: barbells, kettlebells, pull-up bars, weights
  | "food"            // nutrition/recipe shots: meal prep, protein shakes, healthy food
  | "texture"         // abstract textures: wood, concrete, metal, fabric
  | "architecture"    // non-identifying architectural details: geometric shapes, lighting, space
  | "nature"          // outdoor/nature: sky, trees, paths, light
  | "product";        // generic product/object close-ups

// NEVER generate: people, faces, bodies, workout poses, identifiable gym interiors.

/**
 * Appended to EVERY prompt, unconditionally. These negatives are the second safety layer
 * behind classifyBrief's refusal: even a benign subject is generated with people/faces/
 * bodies/logos/text explicitly excluded.
 */
export const HARD_NEGATIVES =
  "no people, no faces, no bodies, no hands, no workout poses, no gym interior, " +
  "no logos, no text, studio lighting, product photography, professional quality";

/** Per-category prompt scaffolds. `{subject}` is filled by buildPrompt. */
export const CATEGORY_TEMPLATES: Record<SafeImageCategory, string> = {
  equipment: "Professional studio product photography of {subject}, isolated on neutral background, studio lighting, sharp focus, commercial quality",
  food: "Professional food photography of {subject}, overhead shot, natural lighting, clean presentation, restaurant quality",
  texture: "Abstract texture photograph of {subject}, macro photography, high detail, artistic composition",
  architecture: "Architectural detail photograph of {subject}, clean lines, professional real estate photography style",
  nature: "Nature photography of {subject}, golden hour lighting, landscape photography, professional quality",
  product: "Studio product photography of {subject}, clean background, professional lighting, commercial quality",
};

/**
 * Thrown by classifyBrief when a brief asks for a forbidden subject. `suggestion` gives the
 * caller (and, upstream, the site owner) a safe way to re-phrase the request.
 */
export class UnsafeBriefError extends Error {
  readonly suggestion: string;
  constructor(message: string, suggestion: string) {
    super(message);
    this.name = "UnsafeBriefError";
    this.suggestion = suggestion;
  }
}

/**
 * Words/phrases that make a brief unsafe. Matched case-insensitively as whole-ish tokens.
 * If ANY of these appears, the brief is refused — we do not try to "clean" it.
 */
const UNSAFE_PATTERNS: RegExp[] = [
  /\bpeople\b/i,
  /\bperson\b/i,
  /\bathletes?\b/i,
  /\bmembers?\b/i,
  /\bcoach(es)?\b/i,
  /\btrainers?\b/i,
  /\bteam\b/i,
  /\bfaces?\b/i,
  /\bbod(y|ies)\b/i,
  /\bhands?\b/i,
  /\bsomeone\b/i,
  /\bworkout pose/i,
  /\bmid-?workout\b/i,
  // "gym" only when it reads as an identifiable INTERIOR (interior/inside/our gym/the gym).
  /\b(interior|inside|our|the)\s+\w*\s*gym\b/i,
  /\bgym\s+(interior|inside)\b/i,
];

/**
 * Ordered category signal table. First category whose keyword matches wins. `product` is the
 * catch-all fallback and has no entry here — it is returned when nothing else matches.
 *
 * Order matters: more specific/nameable categories are checked before broad ones so, e.g.,
 * "concrete texture" resolves to `texture` rather than being swept into `product`.
 */
const CATEGORY_SIGNALS: Array<[SafeImageCategory, RegExp[]]> = [
  ["equipment", [/\bbarbell\b/i, /\bkettlebell\b/i, /\bdumbbell\b/i, /\bpull-?up bar\b/i, /\bweight(s| plate)/i, /\brack\b/i, /\bequipment\b/i, /\bgym gear\b/i]],
  ["food", [/\bmeal\b/i, /\bmeal prep\b/i, /\bfood\b/i, /\bprotein\b/i, /\bshake\b/i, /\bsmoothie\b/i, /\brecipe\b/i, /\bnutrition\b/i, /\bhealthy\b/i]],
  ["texture", [/\btexture\b/i, /\bconcrete\b/i, /\bwood(en)?\b/i, /\bmetal\b/i, /\bfabric\b/i, /\bpattern\b/i, /\bsurface\b/i, /\bbrushed\b/i]],
  ["architecture", [/\barchitectur/i, /\bgeometric\b/i, /\blighting\b/i, /\bspace\b/i, /\bbuilding\b/i, /\bstructure\b/i]],
  ["nature", [/\bnature\b/i, /\bsky\b/i, /\btrees?\b/i, /\bforest\b/i, /\bpath\b/i, /\btrail\b/i, /\boutdoor\b/i, /\bsunrise\b/i, /\bsunset\b/i, /\blandscape\b/i]],
];

/**
 * Heuristically classify an owner's brief into a SafeImageCategory. No LLM.
 *
 * Refuses (throws UnsafeBriefError) if the brief demands people/faces/bodies/workout poses or an
 * identifiable gym interior. Otherwise returns the first matching category, defaulting to
 * `product` when nothing else matches (a generic, safe fallback).
 */
export function classifyBrief(brief: string): SafeImageCategory {
  for (const re of UNSAFE_PATTERNS) {
    if (re.test(brief)) {
      throw new UnsafeBriefError(
        `Brief "${brief}" would require generating people, bodies, or an identifiable interior, which is not allowed.`,
        "Describe a safe subject instead — e.g. equipment (a barbell, kettlebells), a texture (concrete, wood), or an architectural detail (clean lines, lighting).",
      );
    }
  }

  for (const [category, signals] of CATEGORY_SIGNALS) {
    if (signals.some((re) => re.test(brief))) return category;
  }

  return "product";
}

/**
 * Build the final Flux prompt for a (category, subject) pair. Fills the category template's
 * `{subject}` slot and appends HARD_NEGATIVES (always, at the end).
 */
export function buildPrompt(category: SafeImageCategory, subject: string): string {
  const template = CATEGORY_TEMPLATES[category];
  const filled = template.replace("{subject}", subject);
  return `${filled}, ${HARD_NEGATIVES}`;
}
```

CREATE `src/assets/index.ts`:

```ts
// Barrel for the safe-asset generation subsystem.
export {
  buildPrompt,
  classifyBrief,
  UnsafeBriefError,
  HARD_NEGATIVES,
  CATEGORY_TEMPLATES,
  type SafeImageCategory,
} from "./safety.ts";
export { generateAsset } from "./generate.ts";
export type { GenerateAssetArgs, GenerateAssetResult } from "./generate.ts";
```

> NOTE: `index.ts` references `./generate.ts` which does not exist until T1. To keep T0 green in isolation, comment out the two `generate.ts` lines in `index.ts` for now (add a `// TODO(T1): uncomment when generate.ts lands`), then uncomment them in T1. Alternatively create a stub `src/assets/generate.ts` in T1 before wiring — either way the test only imports from `safety.ts`, so the barrel is not on T0's test path. Simplest: in T0, write `index.ts` with ONLY the `safety.ts` re-exports, and add the `generate.ts` exports in T1.

For T0, write `src/assets/index.ts` as:

```ts
// Barrel for the safe-asset generation subsystem.
export {
  buildPrompt,
  classifyBrief,
  UnsafeBriefError,
  HARD_NEGATIVES,
  CATEGORY_TEMPLATES,
  type SafeImageCategory,
} from "./safety.ts";
// generate.ts exports are added in T1.
```

### T0 verify

```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/
```
Expected: `safety.test.ts` passes — all `buildPrompt`, `classifyBrief`, and refusal cases green.

```bash
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```
Expected: no errors.

### T0 commit

```bash
cd packages/clone-engine
git add src/assets/safety.ts src/assets/index.ts test/assets/safety.test.ts
git commit -m "feat(assets): safe-image prompt layer — categories, templates, buildPrompt, classifyBrief (T0)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```

---

## T1 — generate.ts: the generateAsset orchestrator (mocked HTTP)

**Files:**
- CREATE `src/assets/generate.ts`
- EDIT `src/assets/index.ts` (uncomment/add the `generate.ts` re-exports)
- CREATE `test/assets/generate.test.ts`

### T1 red — write the test first

The test mocks BOTH network hops with a single `fetch` stub: the Flux POST (returns `{ images: [{ url }] }`) and the image GET (returns image bytes). `swapAsset` is invoked for real against a tiny on-disk fixture site so we prove the whole download→swap→cleanup path, OR `swapAsset` is spied/mocked — this plan uses a REAL minimal fixture so the swap actually lands (matches the repo's preference for real seams; see `test/edit/ops.test.ts`). Rollback + tmp cleanup are asserted directly.

CREATE `test/assets/generate.test.ts`:

```ts
/**
 * generate.test.ts — generateAsset orchestration, with ALL network calls mocked.
 *
 * NO real HTTP: a single vi.stubGlobal('fetch', …) serves both the Flux POST (JSON) and the
 * image GET (bytes). The real swapAsset runs against a minimal on-disk fixture site so the
 * download→swap→cleanup path is exercised end-to-end.
 *
 * Tests:
 *   1. Happy path: classify → prompt → Flux → download → swapAsset lands, ok:true, no tmp left.
 *   2. Explicit category override is honored (skips classification).
 *   3. Unsafe brief is refused BEFORE any fetch: ok:false, fetch never called, no swap.
 *   4. Flux failure (non-2xx) → ok:false with a failure message, no swap, no tmp left.
 *   5. aspectRatio maps to the right image_size in the request body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateAsset } from "../../src/assets/generate.ts";
import type { SiteRef } from "../../src/edit/types.ts";

// A 1x1 PNG (valid magic bytes so swapAsset's sniffExt returns "png").
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Build a minimal projected site fixture with ONE asset alias ("hero-image") that resolveAsset
 * can find and swapAsset can replace. Mirrors the shape swapAsset + resolveAsset expect:
 *   <dir>/site.json  with pages[0].assets = [{ alias: "hero-image", file: "assets/a1.png" }]
 *   <dir>/astro/public/assets/a1.png
 *   <dir>/assets/a1.png  (root copy)
 *   a component .astro under astro/src/components that references /assets/a1.png
 */
function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-asset-"));
  const publicAssets = path.join(dir, "astro", "public", "assets");
  const rootAssets = path.join(dir, "assets");
  const components = path.join(dir, "astro", "src", "components");
  fs.mkdirSync(publicAssets, { recursive: true });
  fs.mkdirSync(rootAssets, { recursive: true });
  fs.mkdirSync(components, { recursive: true });

  fs.writeFileSync(path.join(publicAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(rootAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(
    path.join(components, "HeroSection.astro"),
    `---\nconst content = [];\n---\n<section data-component="HeroSection"><img src="/assets/a1.png" /></section>\n`,
  );

  const manifest = {
    pages: [
      {
        route: "/",
        component: "HomePage",
        type: "home",
        goal: "trust",
        sections: [
          { name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] },
        ],
        elements: [],
        assets: [{ alias: "hero-image", file: "assets/a1.png" }],
        copy: [],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

/**
 * A fetch stub that answers the Flux POST with the given imageUrl, then answers the subsequent
 * image GET with PNG bytes. Records every call for assertions.
 */
function stubFetch(opts: { imageUrl: string; fluxOk?: boolean; imageBytes?: Buffer }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("fal.run")) {
      if (opts.fluxOk === false) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response(JSON.stringify({ images: [{ url: opts.imageUrl }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // The image download hop.
    return new Response(opts.imageBytes ?? PNG_1x1, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function tmpFilesUnder(dir: string): string[] {
  // generateAsset writes its download to os.tmpdir(); list any leftover gen-asset image tmp files.
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("gen-asset-img-"));
}

describe("generateAsset", () => {
  let site: SiteRef;

  beforeEach(() => {
    site = makeFixtureSite();
    process.env.FAL_API_KEY = "test-key"; // present so the code path proceeds; fetch is mocked anyway.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(site.dir, { recursive: true, force: true });
    // Clean any stray tmp download files a failing test might leave.
    for (const n of tmpFilesUnder(os.tmpdir())) fs.rmSync(path.join(os.tmpdir(), n), { force: true });
  });

  it("happy path: classifies, generates, downloads, and swaps the asset", async () => {
    const { fn, calls } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/generated.png" });

    const result = await generateAsset(site, {
      alias: "hero-image",
      brief: "close-up of a competition kettlebell on a neutral background",
    });

    expect(result.ok).toBe(true);
    expect(result.assetAlias).toBe("hero-image");
    expect(result.failures).toEqual([]);

    // Two hops: Flux POST + image GET.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[0].url).toContain("fal.run");
    expect(calls[1].url).toBe("https://cdn.fal.ai/out/generated.png");

    // The Flux POST carried a safe, category-shaped prompt with the hard negatives.
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.prompt).toContain("kettlebell");
    expect(body.prompt).toContain("no people");
    expect(body.image_size).toBe("landscape_16_9"); // 16:9 default
    expect(body.num_images).toBe(1);

    // Authorization header uses the fal.ai "Key <token>" scheme.
    const headers = new Headers(calls[0].init!.headers);
    expect(headers.get("authorization")).toBe("Key test-key");

    // No tmp download file left behind.
    expect(tmpFilesUnder(os.tmpdir())).toEqual([]);
  });

  it("honors an explicit category override", async () => {
    const { calls } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/x.png" });
    const result = await generateAsset(site, {
      alias: "hero-image",
      brief: "a plain object",       // would classify as product…
      category: "texture",           // …but we force texture.
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(calls[0].init!.body));
    // texture template's distinctive wording.
    expect(body.prompt).toContain("Abstract texture photograph");
  });

  it("refuses an unsafe brief BEFORE any network call", async () => {
    const { fn } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/x.png" });
    const result = await generateAsset(site, {
      alias: "hero-image",
      brief: "a person lifting weights in our gym",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/people|bodies|not allowed/i);
    // The refusal short-circuits before fetch.
    expect(fn).not.toHaveBeenCalled();
    // No swap happened — component still references the original asset.
    const comp = fs.readFileSync(path.join(site.dir, "astro", "src", "components", "HeroSection.astro"), "utf8");
    expect(comp).toContain("/assets/a1.png");
  });

  it("fails cleanly when Flux returns a non-2xx", async () => {
    const { fn } = stubFetch({ imageUrl: "unused", fluxOk: false });
    const result = await generateAsset(site, {
      alias: "hero-image",
      brief: "a barbell close-up",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/flux|fal\.ai|500|generation/i);
    // Only the Flux POST was attempted (no image GET after failure).
    expect(fn).toHaveBeenCalledTimes(1);
    expect(tmpFilesUnder(os.tmpdir())).toEqual([]);
  });

  it("maps aspectRatio 1:1 to square_hd", async () => {
    const { calls } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/sq.png" });
    await generateAsset(site, {
      alias: "hero-image",
      brief: "a kettlebell",
      aspectRatio: "1:1",
    });
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.image_size).toBe("square_hd");
  });
});
```

Run it — MUST fail (module `generate.ts` not found):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/
```

### T1 green — implement generate.ts

CREATE `src/assets/generate.ts`:

```ts
/**
 * generate.ts — generateAsset: safe AI image generation, swapped into the site.
 *
 * Pipeline:
 *   owner brief + optional category
 *     → classifyBrief (or use the explicit category) — REFUSES people/body/interior briefs
 *     → buildPrompt: category template + subject + HARD_NEGATIVES
 *     → POST https://fal.run/fal-ai/flux/dev (Authorization: Key ${FAL_API_KEY}) → image URL
 *     → download the image to an os.tmpdir() file
 *     → swapAsset(site, alias, tmpFile)  ← the storage + manifest update (reused, not reimplemented)
 *     → delete the tmp file
 *     → { ok, assetAlias, failures }
 *
 * SAFETY (v1): no post-generation vision check. The two guards are classifyBrief's refusal and
 * the HARD_NEGATIVES baked into every prompt (see safety.ts). This function's job is orchestration
 * and never-throw error surfacing: any failure (unsafe brief, missing key, Flux error, download
 * error, swap error) is caught and returned as { ok:false, failures:[…] } so the apply loop can
 * roll back — consistent with how apply.ts treats a throwing op.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { SiteRef } from "../edit/types.ts";
import { swapAsset } from "../edit/ops.ts";
import { buildPrompt, classifyBrief, UnsafeBriefError, type SafeImageCategory } from "./safety.ts";

const FAL_ENDPOINT = "https://fal.run/fal-ai/flux/dev";

export interface GenerateAssetArgs {
  /** The site asset alias to replace (e.g. "hero-image"). Must exist in site.json. */
  alias: string;
  /** Owner's description, e.g. "hero image for the CrossFit page". */
  brief: string;
  /** Optional category override; auto-classified from the brief when omitted. */
  category?: SafeImageCategory;
  /** Output aspect ratio. Default "16:9" (landscape). */
  aspectRatio?: "16:9" | "1:1" | "4:3";
}

export interface GenerateAssetResult {
  ok: boolean;
  assetAlias: string;
  failures: string[];
}

/** Map the caller's aspect ratio to fal.ai's `image_size` enum. */
function imageSizeFor(aspectRatio: GenerateAssetArgs["aspectRatio"]): string {
  switch (aspectRatio) {
    case "1:1":
      return "square_hd";
    case "4:3":
      return "landscape_4_3";
    case "16:9":
    default:
      return "landscape_16_9";
  }
}

/**
 * Generate a safe image from `brief` and swap it into `alias`. Never throws — every failure is
 * returned as { ok:false, failures:[…] }.
 */
export async function generateAsset(
  site: SiteRef,
  args: GenerateAssetArgs,
): Promise<GenerateAssetResult> {
  const { alias, brief } = args;

  // 1. Classify (or use the override). An unsafe brief is refused HERE, before any network call.
  let category: SafeImageCategory;
  try {
    category = args.category ?? classifyBrief(brief);
  } catch (err) {
    if (err instanceof UnsafeBriefError) {
      return { ok: false, assetAlias: alias, failures: [`${err.message} Suggestion: ${err.suggestion}`] };
    }
    return { ok: false, assetAlias: alias, failures: [`generateAsset: classify failed: ${(err as Error).message}`] };
  }

  // 2. Build the safe prompt.
  const prompt = buildPrompt(category, brief);

  // 3. Require the API key (read lazily so the module imports without it).
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    return { ok: false, assetAlias: alias, failures: ["generateAsset: FAL_API_KEY is not set"] };
  }

  // 4. Call Flux.
  let imageUrl: string;
  try {
    const res = await fetch(FAL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Key ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        image_size: imageSizeFor(args.aspectRatio),
        num_inference_steps: 28,
        num_images: 1,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      return { ok: false, assetAlias: alias, failures: [`generateAsset: Flux (fal.ai) returned ${res.status}`] };
    }
    const json = (await res.json()) as { images?: Array<{ url?: string }> };
    const url = json.images?.[0]?.url;
    if (!url) {
      return { ok: false, assetAlias: alias, failures: ["generateAsset: Flux response had no image URL"] };
    }
    imageUrl = url;
  } catch (err) {
    return { ok: false, assetAlias: alias, failures: [`generateAsset: Flux request failed: ${(err as Error).message}`] };
  }

  // 5. Download the generated image to a tmp file, then swapAsset from it, then clean up.
  const tmpFile = path.join(os.tmpdir(), `gen-asset-img-${crypto.randomUUID()}`);
  try {
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    if (!imgRes.ok) {
      return { ok: false, assetAlias: alias, failures: [`generateAsset: image download returned ${imgRes.status}`] };
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    fs.writeFileSync(tmpFile, buf);

    // The storage + manifest update — reuse swapAsset verbatim (handles type sniff, ref rewrite,
    // both storage dirs, and site.json).
    await swapAsset(site, alias, tmpFile);
  } catch (err) {
    return { ok: false, assetAlias: alias, failures: [`generateAsset: swap failed: ${(err as Error).message}`] };
  } finally {
    // Always clean up the tmp download, success or failure.
    fs.rmSync(tmpFile, { force: true });
  }

  return { ok: true, assetAlias: alias, failures: [] };
}
```

EDIT `src/assets/index.ts` — replace the `// generate.ts exports are added in T1.` comment with the real re-exports so the barrel matches the T0-planned shape:

```ts
// Barrel for the safe-asset generation subsystem.
export {
  buildPrompt,
  classifyBrief,
  UnsafeBriefError,
  HARD_NEGATIVES,
  CATEGORY_TEMPLATES,
  type SafeImageCategory,
} from "./safety.ts";
export { generateAsset } from "./generate.ts";
export type { GenerateAssetArgs, GenerateAssetResult } from "./generate.ts";
```

### T1 verify

```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/
```
Expected: both `safety.test.ts` and `generate.test.ts` pass — happy path, override, refusal (no fetch), Flux failure, and aspectRatio mapping all green.

```bash
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```
Expected: no errors.

### T1 commit

```bash
cd packages/clone-engine
git add src/assets/generate.ts src/assets/index.ts test/assets/generate.test.ts
git commit -m "feat(assets): generateAsset orchestrator — Flux (fal.ai) → download → swapAsset (T1)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```

---

## T2 — wire generateAsset into the edit op surface

Add `generateAsset` as a first-class `EditOp`: union member, Zod schema variant, planner validation, apply dispatch, planner prompt, and the public barrel.

**Files:**
- EDIT `src/edit/types.ts` — `EditOp` union + `EditOpSchema` + `targetIdentity` (via apply.ts)
- EDIT `src/edit/apply.ts` — dispatch case + `targetIdentity` case
- EDIT `src/edit/plan.ts` — `validateOpTarget` case + `SYSTEM_PROMPT`
- EDIT `src/index.ts` — export the assets barrel
- EDIT `test/edit/types.test.ts` — schema round-trip for the new variant
- CREATE `test/assets/op-wiring.test.ts` — plan-validation + apply-dispatch coverage (mocked)

### T2 red — write the tests first

Append to `test/edit/types.test.ts` a case proving `EditOpSchema` accepts the new variant. First read the file to match its existing style; then add:

```ts
it("EditOpSchema accepts a generateAsset op", () => {
  const op = {
    op: "generateAsset",
    alias: "hero-image",
    brief: "a barbell close-up",
    category: "equipment",
    aspectRatio: "16:9",
  };
  const parsed = EditOpSchema.parse(op);
  expect(parsed.op).toBe("generateAsset");
});

it("EditOpSchema accepts generateAsset with only the required fields", () => {
  const parsed = EditOpSchema.parse({ op: "generateAsset", alias: "hero-image", brief: "a kettlebell" });
  expect(parsed.op).toBe("generateAsset");
});

it("EditOpSchema rejects a generateAsset op with an invalid category", () => {
  expect(() =>
    EditOpSchema.parse({ op: "generateAsset", alias: "h", brief: "x", category: "people" }),
  ).toThrow();
});
```

CREATE `test/assets/op-wiring.test.ts` — proves the planner validates the alias (drops a hallucinated alias, keeps a real one) and that apply dispatches to generateAsset. The apply-dispatch check mocks fetch (same stub as T1) and uses the same minimal fixture. To avoid duplicating the fixture, export the fixture builder from a shared helper OR inline it — inline here for a self-contained test:

```ts
/**
 * op-wiring.test.ts — generateAsset as a first-class EditOp.
 *
 * Covers the two seams T2 adds:
 *   - plan.ts validateOpTarget drops a generateAsset op whose alias is NOT on the site
 *     (hallucinated), and keeps one whose alias IS on the site.
 *   - apply.ts dispatches op "generateAsset" to generateAsset() (verified via a mocked fetch:
 *     a real dispatch performs the Flux POST; a missing case would never call fetch).
 *
 * All network is mocked. The planner test uses the REAL plan() with a fakeChat returning the op.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plan } from "../../src/edit/plan.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-wiring-"));
  const publicAssets = path.join(dir, "astro", "public", "assets");
  const components = path.join(dir, "astro", "src", "components");
  const styles = path.join(dir, "astro", "src", "styles");
  fs.mkdirSync(publicAssets, { recursive: true });
  fs.mkdirSync(components, { recursive: true });
  fs.mkdirSync(styles, { recursive: true });
  fs.writeFileSync(path.join(publicAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "assets", "a1.png") /* fallback dir */, PNG_1x1);
  fs.writeFileSync(
    path.join(components, "HeroSection.astro"),
    `---\nconst content = [];\n---\n<section data-component="HeroSection"><img src="/assets/a1.png" /></section>\n`,
  );
  // brand.json so digest()/plan() have what they need (minimal).
  fs.mkdirSync(path.join(dir, "astro"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "astro", "brand.json"),
    JSON.stringify({ colors: { primary: { hex: "#000000", value: "rgb(0,0,0)", variants: {} }, accent: { hex: "#111111", value: "rgb(17,17,17)", variants: {} }, surface: { hex: "#ffffff", value: "rgb(255,255,255)", variants: {} }, text: { hex: "#222222", value: "rgb(34,34,34)", variants: {} }, muted: { hex: "#888888", value: "rgb(136,136,136)", variants: {} } }, space: {}, radius: {} }, null, 2),
  );
  const manifest = {
    pages: [
      {
        route: "/",
        component: "HomePage",
        type: "home",
        goal: "trust",
        sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }],
        elements: [],
        assets: [{ alias: "hero-image", file: "assets/a1.png" }],
        copy: [],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

/** A ChatFn that always returns the given JSON string as the assistant message. */
function fakeChat(json: string): ChatFn {
  return async (): Promise<ChatResponse> => ({ content: json, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
}

describe("plan validates generateAsset alias", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("keeps a generateAsset op whose alias exists", async () => {
    const chat = fakeChat(JSON.stringify({
      needsInfo: false,
      summary: "regen hero",
      ops: [{ op: "generateAsset", alias: "hero-image", brief: "a barbell" }],
    }));
    const result = await plan(site, [{ role: "user", content: "regenerate the hero image as a barbell" }], chat, "test-model");
    expect(result.needsInfo).toBe(false);
    if (!result.needsInfo) {
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe("generateAsset");
    }
  });

  it("drops a generateAsset op whose alias does NOT exist (hallucination)", async () => {
    const chat = fakeChat(JSON.stringify({
      needsInfo: false,
      summary: "regen missing",
      ops: [{ op: "generateAsset", alias: "does-not-exist", brief: "a barbell" }],
    }));
    const result = await plan(site, [{ role: "user", content: "regenerate the nonexistent image" }], chat, "test-model");
    // The only op was dropped → the plan has no applicable ops. plan() surfaces this via `dropped`.
    if (!result.needsInfo) {
      expect(result.ops).toHaveLength(0);
      expect(result.dropped?.length).toBe(1);
    }
  });
});
```

> NOTE on the "drops → 0 ops" assertion: confirm how `plan()` returns when every op is dropped. Read `src/edit/plan.ts` lines ~96–140 (the loop after `validateOpTarget`) to see whether it returns `{ needsInfo:false, ops:[], dropped:[…] }` or converts an all-dropped plan into a `needsInfo:true`. Match the assertion to the ACTUAL behavior — do not assume. If plan() throws or reshapes on empty ops, assert that instead. The load-bearing point is: a hallucinated alias must NOT survive validation.

Run — MUST fail: `EditOpSchema` has no `generateAsset` variant yet, so both `types.test.ts` new cases and the plan validation fail.
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/ test/edit/types.test.ts
```

### T2 green — implement the wiring

**1. `src/edit/types.ts` — add the union member.** In the `EditOp` union (after `addNavLink`), add:

```ts
  | { op: "generateAsset"; alias: string; brief: string; category?: SafeImageCategory; aspectRatio?: "16:9" | "1:1" | "4:3" };
```

Add the import at the top of `types.ts` (after the existing imports):

```ts
import type { SafeImageCategory } from "../assets/safety.ts";
```

**2. `src/edit/types.ts` — add the Zod variant.** In `EditOpSchema`'s `z.discriminatedUnion("op", [ … ])`, add as the last member:

```ts
  z.object({
    op: z.literal("generateAsset"),
    alias: z.string().min(1),
    brief: z.string().min(1),
    category: z.enum(["equipment", "food", "texture", "architecture", "nature", "product"]).optional(),
    aspectRatio: z.enum(["16:9", "1:1", "4:3"]).optional(),
  }),
```

> The Zod `category` enum literals MUST stay in sync with `SafeImageCategory`. They are duplicated here (Zod can't derive from a TS type). Keep the six values identical.

**3. `src/edit/apply.ts` — dispatch case.** Add the import near the other ops imports:

```ts
import { generateAsset } from "../assets/generate.ts";
```

In `applyOpsDeterministically`'s `switch (op.op)`, add a case (before the closing brace, alongside the others):

```ts
      case "generateAsset": {
        const genResult = await generateAsset(site, {
          alias: op.alias,
          brief: op.brief,
          category: op.category,
          aspectRatio: op.aspectRatio,
        });
        if (!genResult.ok) {
          // Surface as a throw so apply()'s catch rolls back the (un)changed site — same contract
          // as generateSection. A failed generation must not leave a partial edit.
          throw new Error(`generateAsset failed: ${genResult.failures.join("; ")}`);
        }
        // swapAsset already ran inside generateAsset; report the changed alias's sections. We don't
        // have swapAsset's OpResult here, so treat it like a swapAsset on this alias for intent:
        // editedSections is derived by the verifier from the changed files. Report empty targetSections
        // and let the whole-batch "nothing else changed" guarantee cover it (the image swap changes
        // only the referenced element's box).
        results.push({ op, changedFiles: [], targetSections: [] });
        break;
      }
```

> VERIFIER NOTE for the implementer: `generateAsset` returns `{ ok, assetAlias, failures }`, not swapAsset's `OpResult`. If the verifier needs the touched sections to keep untouched-sections at 0-px, consider having `generateAsset` return `swapAsset`'s `OpResult` too (optional field) so the dispatch can populate `targetSections`. For v1, the empty targetSections is acceptable because an image swap changes only the `<img>`/`background` box; if the verifier flags collateral, thread swapAsset's OpResult through. This is the same "structural + render-sanity is the guarantee" posture used by generateSection/addSection. Decide based on whether the T3 full-suite apply tests flag it — do NOT prematurely over-engineer.

In `targetIdentity(op)` (same file), add a case:

```ts
    case "generateAsset":
      return `generateAsset:${op.alias}`;
```

**4. `src/edit/plan.ts` — validate the alias.** In `validateOpTarget`'s switch, add:

```ts
    case "generateAsset":
      // The target alias must exist on the site (same check swapAsset does).
      resolveAsset(site, parsed.alias);
      break;
```

**5. `src/edit/plan.ts` — teach the planner the op.** In `SYSTEM_PROMPT`, after the `addNavLink` block, add:

```
For REPLACING AN IMAGE with a freshly generated one use generateAsset (targets an existing asset alias):
  { op: "generateAsset", alias: "<existing asset alias>", brief: "<what the image should show>" }
  SAFE subjects ONLY: gym equipment, food/nutrition, textures, architectural details, nature, generic products.
  NEVER request people, faces, bodies, workout poses, or identifiable gym interiors — those are refused.
  Optional: category ("equipment"|"food"|"texture"|"architecture"|"nature"|"product"), aspectRatio ("16:9"|"1:1"|"4:3", default 16:9).
```

**6. `src/index.ts` — export the assets barrel.** Add near the `edit` export:

```ts
// Safe AI image generation — generateAsset + the safe-image prompt layer.
export * as assets from "./assets/index.ts";
```

### T2 verify

```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/ test/edit/types.test.ts
```
Expected: the new `types.test.ts` schema cases pass; `op-wiring.test.ts` plan-validation cases pass (alias kept / hallucination dropped).

```bash
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```
Expected: no errors — the `EditOp` union, `EditOpSchema`, `apply.ts` switch (which is exhaustive over `op.op`), and `targetIdentity` (also exhaustive) all now cover `generateAsset`. If tsc complains about a non-exhaustive switch anywhere else that switches on `EditOp["op"]`, add the missing case there too (search: `grep -rn "op.op" src/`).

### T2 commit

```bash
cd packages/clone-engine
git add src/edit/types.ts src/edit/apply.ts src/edit/plan.ts src/index.ts test/edit/types.test.ts test/assets/op-wiring.test.ts
git commit -m "feat(assets): wire generateAsset into EditOp — schema, plan validation, apply dispatch, planner prompt (T2)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```

---

## T3 — full suite green

No new code. Prove the whole assets suite is green and the edit suite the new op touches did not regress, and the typecheck is clean.

### T3 verify

```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/assets/
```
Expected: `safety.test.ts`, `generate.test.ts`, `op-wiring.test.ts` — all green, zero failures.

```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/
```
Expected: the edit suite passes (or is unchanged from its pre-existing pass/skip state — apply/plan/types tests must not regress). If a pre-existing test was already failing/skipped for unrelated reasons (e.g. real-LLM `eval-llm.ts`, browser-contention `apply.test.ts`), confirm your changes are not the cause: run the specific file and compare against `main`.

```bash
cd packages/clone-engine && node_modules/.bin/tsc --noEmit
```
Expected: no errors.

### T3 commit

Only if any incidental fixes were needed to make the full suite green (e.g. an additional exhaustive-switch case surfaced by tsc). If T2 left everything green, there is nothing to commit — record that in the task report. Otherwise:

```bash
cd packages/clone-engine
git add <exact files touched>
git commit -m "test(assets): full generateAsset suite + edit-suite regression check green (T3)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```

---

## Appendix — invariants the implementer must preserve

1. **Never a real HTTP call in tests.** Every test that could reach fal.ai stubs `fetch` and restores it (`vi.unstubAllGlobals()` in `afterEach`). CI must pass with no `FAL_API_KEY` and no network.
2. **Safety is two-layered and both layers are in `safety.ts`.** Do not move refusal logic into `generate.ts` beyond calling `classifyBrief`. The `HARD_NEGATIVES` must be appended by `buildPrompt`, never assembled ad hoc at the call site.
3. **Reuse `swapAsset`.** `generate.ts` must not touch `site.json`, asset dirs, or ref rewriting directly. All storage goes through `swapAsset`.
4. **`generateAsset` never throws to its own caller** — it returns `{ ok:false, failures }`. Only the `apply.ts` dispatch converts a `!ok` into a throw, so `apply()`'s existing catch+rollback owns the "never ship a broken edit" guarantee.
5. **Tmp files are always cleaned up** via the `finally` block, on both success and failure.
6. **Zod `category` enum stays in sync** with the `SafeImageCategory` union (six identical literals).
7. **Exhaustive switches.** `EditOp["op"]` switches in `apply.ts` (`applyOpsDeterministically`, `targetIdentity`) and `plan.ts` (`validateOpTarget`) must all include the `generateAsset` case — tsc enforces the first two; `validateOpTarget` uses a `switch` on a parsed union so add it explicitly.
