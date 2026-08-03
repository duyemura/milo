# composePage — UGC Content Page Creation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `composePage` orchestrator to the Milo clone engine that creates a complete, on-brand content page (blog / local-SEO / recipe / event / challenge) from a single natural-language brief — by composing the *existing* primitives (`addPage`, `generateSection`, SEO meta, `addNavLink`, snapshot/restore) into one atomic, reversible pipeline. `composePage` writes **no HTML or CSS itself**; every section it emits comes from the bounded template library, so on-brand/on-contract guarantees are inherited for free.

**Architecture:**
- New leaf module `src/ugc/` with three files:
  - `blueprints.ts` — the `ContentKind` type + the `BLUEPRINTS` constant (kind → ordered `GenerateRole[]`) + a pure `titleFromRoute` helper. Zero I/O, zero deps beyond the `GenerateRole` type. Unit-testable without a browser.
  - `compose.ts` — the `composePage()` orchestrator. Snapshots the site, scaffolds the page, plans a coherent outline in ONE LLM call, fills each section via `generateSection` sequentially, injects LLM-quality SEO meta into the page source, optionally adds a nav link, lightweight-verifies, and rolls back on any failure.
  - `index.ts` — barrel that re-exports the public surface.
- `composePage` operates on a **projected OUT dir** (`SiteRef`), exactly like every other subsystem-C/E op. It calls the existing functions and never duplicates their file surgery.
- **Coherence-first copy:** a single planning LLM call outlines all section briefs up front so the N generated sections tell one coherent story instead of contradicting each other. The planning call is separate from the per-section copy fills that `generateSection` already performs internally.
- **Atomicity via snapshot/restore:** one snapshot at the top; on ANY failure (a section fails its oracle, the SEO call throws, a lightweight-verify assertion fails) restore to that snapshot and return `{ ok: false, failures }`. Success leaves a fully-built, verified page.

**Tech Stack:** Node 24 + TypeScript (ESM, `.ts` import specifiers), Vitest (`--no-file-parallelism`), Zod (via `@milo/llm`'s `llmJson`), Playwright (integration only, shared browser), `project()` on the speakeasy golden fixture. LLM is mocked in tests with the `fakeChat` pattern.

---

## Key facts the implementation must respect (verified against the codebase)

1. **`generateSection` signature** (`src/edit/generate.ts:238`):
   ```ts
   generateSection(site, args, chat, model, browser, opts?) : Promise<GenerateSectionResult>
   // args: { role: string; goal?; brief: string; afterSection?; targetRoute?: string | string[] | "all" }
   // result: { ok: boolean; sectionName: string; verifierReport: VerifierReport }
   ```
   It appends the section to the **end** of the target page (no `afterSection` → append). Calling it repeatedly with the same `targetRoute` builds the page top-to-bottom in blueprint order. It rolls back its OWN insertion on oracle failure but does **not** touch other sections.

2. **`generateSection`'s non-home verify is lightweight** (`generate.ts:335-365`): for any `targetRoute !== "/"` it checks file existence + `site.json` membership only (no pixel diff). Since `composePage` targets a freshly-added route (never `/`), each section goes through the lightweight path — this is expected and correct (the homepage pixel oracle can't see non-home sections).

3. **`addPage`** (`src/edit/ops.ts:1088`) auto-picks a template page via `pickTemplatePage`, clones its sections into page-namespaced components, and writes `astro/src/pages/<slug>.astro`. **The blueprint wants a clean page**, but `addPage` always clones a template's sections. Therefore, after `addPage`, `composePage` must **remove the cloned sections** so the page starts empty before `generateSection` fills it from the blueprint. Use `removeSection` (`ops.ts:692`) on each cloned section name (returned in `addPage`'s `OpResult.targetSections`). This leaves an empty, buildable page wrapper (imports/includes stripped, `site.json` cleaned).

4. **Route → slug sanitizer** is duplicated in `addPage` (`ops.ts:1097-1101`) and `generate.ts`. `composePage` must derive the canonical route the same way to look up the page in `site.json` afterward: `addPage` stores the page under `route = "/" + cleanSlug + "/"`. `composePage` receives a route like `/blog/best-crossfit-brooklyn/`; `addPage`'s sanitizer collapses `/` to `-`, yielding slug `blog-best-crossfit-brooklyn` and stored route `/blog-best-crossfit-brooklyn/`. **`composePage` must use the sanitized route** (not the raw input) for all subsequent `generateSection` `targetRoute` args and for the final verify lookup. Compute it once with a shared `slugify` helper and reuse.

5. **SEO meta injection target is the page `.astro` source, NOT dist HTML.** The spec text says "inject via `injectPageMeta` into the page's built dist HTML," but dist is a regenerable build output that is **not** snapshotted (`history.ts:6`) and is overwritten on every rebuild — injecting there would be clobbered by the next build and lost on restore. `addPage` already writes a `<title>`/`<meta name="description">`/`<link rel="canonical">` block into the page `.astro` head (`ops.ts:1199-1208`). The correct, durable target is the page `.astro` source. `injectPageMeta` is idempotent and replaces `<title>` + skips already-present description/canonical — so to *upgrade* the meta we replace the title and the pre-existing description tag. Implement a small `applyPageMeta(pageAstroSrc, meta)` that (a) replaces `<title>…</title>`, and (b) replaces the existing `<meta name="description" content="…">` value (since `injectPageMeta` no-ops when one is already present). This keeps the LLM-quality meta durable across rebuilds and covered by snapshot/restore.

6. **`addNavLink`** (`ops.ts:1246`) finds the nav section by role `"navbar"` or name matching `/nav/i`, is idempotent, and inserts before `</ul>`. `titleFromRoute` supplies default link text.

7. **`fakeChat` pattern** (`test/edit/scenario/generate.test.ts:90`):
   ```ts
   function fakeChat(responses: string[]): ChatFn {
     let i = 0;
     return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
   }
   ```
   `composePage` makes `1 (outline) + N (per-section fills)` LLM calls where N = blueprint length, then `1 (SEO meta)` call = `2 + N` total. The fake must queue responses in that exact order: outline first, then one copy fill per section in blueprint order, then the SEO meta object last.

8. **`ASTRO_MODULES` guard + `project()` fixture** — copy the `findAstroModules()` + `projectFixture()` helpers verbatim from `test/edit/scenario/generate.test.ts:75-99`; wrap integration `describe` in `.skipIf(!ASTRO_MODULES)`.

9. **`llmJson` is imported from `@milo/llm`** (`src/edit/generate.ts:34`): `import { llmJson } from "@milo/llm"; import type { ChatFn } from "@milo/llm";`. `llmJson(schema, { chat, model, messages, temperature? })`.

---

## Public API (final shape)

```ts
// src/ugc/blueprints.ts
export type ContentKind = "blog" | "local-seo" | "recipe" | "event" | "challenge";

export const BLUEPRINTS: Record<ContentKind, GenerateRole[]> = {
  blog:        ["hero", "content-block", "content-block", "media-block", "cta-band"],
  "local-seo": ["hero", "content-block", "feature-grid", "faq", "cta-band"],
  recipe:      ["hero", "content-block", "media-block", "cta-band"],
  event:       ["hero", "content-block", "stats-band", "lead-form"],
  challenge:   ["hero", "content-block", "stats-band", "lead-form"],
};

// src/ugc/compose.ts
export interface ComposePageArgs {
  route: string;
  kind: ContentKind;
  brief: string;
  addToNav?: boolean;
  navText?: string;
}
export interface ComposePageResult {
  ok: boolean;
  route: string;               // the SANITIZED route the page was created at
  sections: string[];          // component names generated (blueprint order)
  siteReport?: { blockerCount: number };
  failures: string[];
}
export function composePage(
  site: SiteRef,
  args: ComposePageArgs,
  chat: ChatFn,
  model: string,
  browser: Browser,
  opts?: { width?: number; assetsFallback?: string | null },
): Promise<ComposePageResult>;
```

Every `GenerateRole` in `BLUEPRINTS` (`hero`, `content-block`, `feature-grid`, `faq`, `cta-band`, `media-block`, `stats-band`, `lead-form`) is a verified key of `TEMPLATE_LIBRARY` (`src/edit/templates.ts:791`).

---

## Task list

- **T0** — types + blueprints (`blueprints.ts`) + unit tests. No browser.
- **T1** — `compose.ts` orchestrator + `index.ts` barrel. (No new test file yet; T2 covers it.)
- **T2** — integration test (`compose.test.ts`, `skipIf(!ASTRO_MODULES)`) + wire exports into `src/index.ts`.
- **T3** — full suite green + typecheck + lint.

Each task is red→green TDD, committed with explicit `git add` paths.

---

## T0 — Types + blueprints (pure, no browser)

### Files
- CREATE `src/ugc/blueprints.ts`
- CREATE `test/ugc/blueprints.test.ts`

### Step 1 (RED): write the unit test first

`test/ugc/blueprints.test.ts`:
```ts
/**
 * blueprints.test.ts — pure unit tests for the UGC blueprint table + route helpers.
 * No browser, no fixtures: BLUEPRINTS is a constant and titleFromRoute/slugify are pure.
 */
import { describe, it, expect } from "vitest";
import { BLUEPRINTS, titleFromRoute, slugify, type ContentKind } from "../../src/ugc/blueprints.ts";
import { isGenerateRole } from "../../src/edit/templates.ts";

describe("BLUEPRINTS", () => {
  const KINDS: ContentKind[] = ["blog", "local-seo", "recipe", "event", "challenge"];

  it("has an entry for every ContentKind", () => {
    for (const k of KINDS) {
      expect(BLUEPRINTS[k], `missing blueprint for kind '${k}'`).toBeTruthy();
      expect(BLUEPRINTS[k].length, `blueprint '${k}' must not be empty`).toBeGreaterThan(0);
    }
  });

  it("every role in every blueprint is a real template-library role (bounded vocabulary)", () => {
    for (const k of KINDS) {
      for (const role of BLUEPRINTS[k]) {
        expect(isGenerateRole(role), `blueprint '${k}' role '${role}' is not in TEMPLATE_LIBRARY`).toBe(true);
      }
    }
  });

  it("every blueprint leads with a hero", () => {
    for (const k of KINDS) {
      expect(BLUEPRINTS[k][0], `blueprint '${k}' should lead with a hero`).toBe("hero");
    }
  });

  it("matches the documented blueprints exactly", () => {
    expect(BLUEPRINTS.blog).toEqual(["hero", "content-block", "content-block", "media-block", "cta-band"]);
    expect(BLUEPRINTS["local-seo"]).toEqual(["hero", "content-block", "feature-grid", "faq", "cta-band"]);
    expect(BLUEPRINTS.recipe).toEqual(["hero", "content-block", "media-block", "cta-band"]);
    expect(BLUEPRINTS.event).toEqual(["hero", "content-block", "stats-band", "lead-form"]);
    expect(BLUEPRINTS.challenge).toEqual(["hero", "content-block", "stats-band", "lead-form"]);
  });
});

describe("slugify", () => {
  it("collapses a nested route to a single flat slug (matches addPage's sanitizer)", () => {
    expect(slugify("/blog/best-crossfit-brooklyn/")).toBe("blog-best-crossfit-brooklyn");
  });
  it("strips leading/trailing slashes and lowercases", () => {
    expect(slugify("/About-US/")).toBe("about-us");
  });
  it("collapses non-alphanumerics to hyphens and trims stray hyphens", () => {
    expect(slugify("/events/summer bash!/")).toBe("events-summer-bash");
  });
  it("throws on a route with no usable characters", () => {
    expect(() => slugify("///")).toThrow(/invalid route/);
    expect(() => slugify("---")).toThrow(/invalid route/);
  });
});

describe("routeOf / titleFromRoute", () => {
  it("routeOf wraps a sanitized slug as /slug/", () => {
    expect(routeOfImportGuard("/blog/best-crossfit-brooklyn/")).toBe("/blog-best-crossfit-brooklyn/");
  });
  it("titleFromRoute renders a Title-Cased human label from a route", () => {
    expect(titleFromRoute("/blog-best-crossfit-brooklyn/")).toBe("Blog Best Crossfit Brooklyn");
    expect(titleFromRoute("/about-us/")).toBe("About Us");
  });
});

// routeOf is exported too; alias here to keep the test literal above readable.
import { routeOf as routeOfImportGuard } from "../../src/ugc/blueprints.ts";
```

Run it — it MUST fail (module doesn't exist yet):
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/ugc/blueprints.test.ts
```
Expected: `Error: Failed to load .../src/ugc/blueprints.ts` / "Cannot find module" — i.e. red because the source file is absent.

### Step 2 (GREEN): write the source

`src/ugc/blueprints.ts`:
```ts
/**
 * blueprints.ts — the UGC content-page blueprint table + route helpers.
 *
 * A "blueprint" maps a ContentKind to an ordered list of GenerateRole values. composePage
 * fills the page top-to-bottom in this order, each role rendered from the BOUNDED template
 * library (src/edit/templates.ts) — so a composed page is on-brand + on-contract BY
 * CONSTRUCTION, exactly like generateSection. Adding a kind is a data-only change here.
 *
 * These are PURE (no I/O). slugify/routeOf mirror addPage's route sanitizer (ops.ts:1097-1101)
 * so composePage can look the page up in site.json after addPage creates it.
 */
import type { GenerateRole } from "../edit/templates.ts";

/** The content-page kinds composePage can build. */
export type ContentKind = "blog" | "local-seo" | "recipe" | "event" | "challenge";

/**
 * Ordered section roles per kind. Every role MUST be a key of TEMPLATE_LIBRARY
 * (enforced by blueprints.test.ts against isGenerateRole).
 */
export const BLUEPRINTS: Record<ContentKind, GenerateRole[]> = {
  blog:        ["hero", "content-block", "content-block", "media-block", "cta-band"],
  "local-seo": ["hero", "content-block", "feature-grid", "faq", "cta-band"],
  recipe:      ["hero", "content-block", "media-block", "cta-band"],
  event:       ["hero", "content-block", "stats-band", "lead-form"],
  challenge:   ["hero", "content-block", "stats-band", "lead-form"],
};

/**
 * Sanitize a raw route to a flat slug — byte-identical to addPage's sanitizer
 * (ops.ts:1097-1101): strip leading/trailing slashes, collapse any non-[a-z0-9-]
 * (including internal "/") to "-", lowercase, trim stray hyphens off the ends.
 * Throws on a route with no usable alphanumerics (empty / all-hyphens).
 */
export function slugify(route: string): string {
  const slug = route
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`slugify: invalid route "${route}"`);
  return slug;
}

/** The canonical stored route for a raw input route: "/<slug>/" (matches addPage). */
export function routeOf(route: string): string {
  return `/${slugify(route)}/`;
}

/** A human-readable Title-Cased label derived from a route (nav text / meta fallback). */
export function titleFromRoute(route: string): string {
  const slug = route.replace(/^\/+|\/+$/g, "");
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
```

Run again — GREEN:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/ugc/blueprints.test.ts
```
Expected: all tests pass (the `slugify`/`routeOf`/`titleFromRoute` + blueprint cases). Sample:
```
✓ test/ugc/blueprints.test.ts (11)
Test Files  1 passed (1)
```

### Step 3: typecheck
```bash
packages/clone-engine/node_modules/.bin/tsc --noEmit
```
Expected: no output (exit 0).

### Step 4: commit
```bash
cd packages/clone-engine
git add src/ugc/blueprints.ts test/ugc/blueprints.test.ts
git commit -m "feat(ugc): content-page blueprint table + route helpers (T0)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```

---

## T1 — `compose.ts` orchestrator + `index.ts` barrel

No new test file in this task (the integration test lands in T2). This task delivers the source and must **typecheck** clean. It is not "green" until T2's integration test runs, but `tsc --noEmit` and `pnpm lint` are the gates here.

### Files
- CREATE `src/ugc/compose.ts`
- CREATE `src/ugc/index.ts`

### `src/ugc/compose.ts`
```ts
/**
 * compose.ts — composePage(): create a complete, on-brand UGC content page from a brief.
 *
 * This is an ORCHESTRATOR: it owns no file surgery of its own. It composes the existing,
 * individually-verified primitives into one atomic, reversible pipeline:
 *
 *   1. snapshot(site)                       — single rollback point for the whole compose.
 *   2. addPage(site, route)                 — scaffold the page (clones a template page).
 *   3. removeSection(...) for each cloned   — empty the page so the blueprint fills it clean.
 *   4. ONE planning LLM call                — outline a coherent brief per section (no
 *                                             contradictions across N independent fills).
 *   5. generateSection(...) x N             — fill each blueprint role, in order, on the page.
 *   6. applyPageMeta(...)                   — inject LLM-quality SEO title/description into the
 *                                             page .astro source (durable; survives rebuild +
 *                                             snapshot/restore — unlike dist HTML).
 *   7. addNavLink(...) if addToNav          — optional nav entry.
 *   8. lightweight verify                   — every blueprint section present in site.json for
 *                                             the route; page .astro exists.
 *   9. on ANY failure → restore(snapshot)   — the site is byte-identical to before; return
 *                                             { ok:false, failures }.
 *
 * composePage writes NO HTML/CSS itself; every section is template-library-rendered, so the
 * on-brand/on-contract guarantees are inherited from generateSection.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Browser } from "playwright";
import { llmJson } from "@milo/llm";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../edit/types.ts";
import type { SiteManifest } from "../types.ts";
import { addPage, addNavLink, removeSection } from "../edit/ops.ts";
import { generateSection } from "../edit/generate.ts";
import { snapshot, restore } from "../edit/history.ts";
import { loadSite } from "../edit/target.ts";
import { generatePageMeta } from "../edit/seo-meta.ts";
import { BLUEPRINTS, routeOf, slugify, titleFromRoute, type ContentKind } from "./blueprints.ts";

export interface ComposePageArgs {
  route: string;
  kind: ContentKind;
  brief: string;
  addToNav?: boolean;
  navText?: string;
}

export interface ComposePageResult {
  ok: boolean;
  /** The SANITIZED route the page was created at (e.g. "/blog-best-crossfit-brooklyn/"). */
  route: string;
  /** Component names generated, in blueprint order. */
  sections: string[];
  /** Lightweight structural check — 0 blockers means the page composed cleanly. */
  siteReport?: { blockerCount: number };
  failures: string[];
}

/** One coherent section brief per blueprint role. Length is validated against the blueprint. */
const OutlineSchema = z.object({
  sectionBriefs: z.array(z.string().min(1)),
});

/** SEO meta the LLM writes for the composed page. */
const MetaSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

const OUTLINE_SYSTEM =
  "You outline a web page from a brief. For each section role in the blueprint, write a short " +
  "(1-2 sentence) section brief that is coherent with the others — one continuous story, no " +
  "contradictions, no repetition. Return JSON { sectionBriefs: string[] } with EXACTLY one brief " +
  "per role, in the given order.";

const META_SYSTEM =
  "You write SEO metadata for a web page. Return JSON { title, description }. Title <= 60 chars, " +
  "description <= 155 chars, both benefit-led and specific to the brief. No quotes around the values.";

/**
 * Inject LLM-quality SEO meta into a page's .astro SOURCE (not dist — dist is regenerable and
 * not snapshotted). Replaces the <title> and the existing <meta name="description"> value that
 * addPage stamped in. Idempotent: replaces in place, never duplicates.
 */
function applyPageMeta(src: string, meta: { title: string; description: string }): string {
  const esc = (s: string) => s.replace(/"/g, "&quot;");
  let out = src.replace(/<title>[^<]*<\/title>/i, `<title>${meta.title}</title>`);
  if (/name="description"/.test(out)) {
    out = out.replace(
      /(<meta\s+name="description"\s+content=")[^"]*(")/i,
      `$1${esc(meta.description)}$2`,
    );
  } else {
    out = out.replace(/<\/head>/i, `<meta name="description" content="${esc(meta.description)}" />\n</head>`);
  }
  return out;
}

/** Absolute path to a page's .astro source for a sanitized slug ("" → index.astro). */
function pageAstroPath(site: SiteRef, slug: string): string {
  const file = slug === "" ? "index.astro" : `${slug}.astro`;
  return path.join(site.dir, "astro", "src", "pages", file);
}

/**
 * Compose a full content page from a brief. Atomic + reversible: on any failure the site is
 * restored byte-identically and { ok:false, failures } is returned.
 */
export async function composePage(
  site: SiteRef,
  args: ComposePageArgs,
  chat: ChatFn,
  model: string,
  browser: Browser,
  opts: { width?: number; assetsFallback?: string | null } = {},
): Promise<ComposePageResult> {
  const failures: string[] = [];
  const blueprint = BLUEPRINTS[args.kind];
  if (!blueprint) {
    return { ok: false, route: args.route, sections: [], failures: [`unknown kind "${args.kind}"`] };
  }

  // Canonical route + slug (matches addPage's sanitizer). Throws on an unusable route.
  let slug: string;
  let route: string;
  try {
    slug = slugify(args.route);
    route = routeOf(args.route);
  } catch (err) {
    return { ok: false, route: args.route, sections: [], failures: [(err as Error).message] };
  }

  // 1. Snapshot — the single rollback point for the whole compose.
  const token = snapshot(site);
  const sections: string[] = [];

  try {
    // 2. Scaffold the page (addPage clones a template page's sections).
    const added = addPage(site, args.route);

    // 3. Empty the page so the blueprint fills it clean (drop every cloned section).
    for (const cloned of added.targetSections) {
      removeSection(site, cloned);
    }

    // 4. ONE planning call: outline a coherent brief per section.
    const outline = await llmJson(OutlineSchema, {
      chat,
      model,
      messages: [
        { role: "system", content: OUTLINE_SYSTEM },
        {
          role: "user",
          content:
            `Page brief: ${args.brief}\n` +
            `Page kind: ${args.kind}\n` +
            `Section roles (in order): ${blueprint.join(", ")}`,
        },
      ],
    });

    // Map an outline brief to each role; fall back to the page brief if the model under-produced.
    const briefFor = (i: number): string => outline.sectionBriefs[i]?.trim() || args.brief;

    // 5. Fill each blueprint role, in order, on the new page.
    for (let i = 0; i < blueprint.length; i++) {
      const role = blueprint[i];
      const res = await generateSection(
        site,
        { role, brief: briefFor(i), targetRoute: route },
        chat,
        model,
        browser,
        opts,
      );
      if (!res.ok) {
        failures.push(
          `section ${i} (${role}) failed: ${res.verifierReport.failures.join(" | ") || "verify failed"}`,
        );
        restore(site, token);
        return { ok: false, route, sections, failures };
      }
      sections.push(res.sectionName);
    }

    // 6. LLM-quality SEO meta → durable page .astro source injection.
    const siteName = readSiteName(site);
    const meta = await llmJson(MetaSchema, {
      chat,
      model,
      messages: [
        { role: "system", content: META_SYSTEM },
        {
          role: "user",
          content: `Page brief: ${args.brief}\nBusiness: ${siteName}\nRoute: ${route}`,
        },
      ],
    });
    const astroPath = pageAstroPath(site, slug);
    if (fs.existsSync(astroPath)) {
      fs.writeFileSync(astroPath, applyPageMeta(fs.readFileSync(astroPath, "utf8"), meta));
    } else {
      // Fall back to deterministic meta path never reached (addPage always writes the file),
      // but keep the branch honest rather than silently skipping.
      failures.push(`page .astro not found for meta injection: ${astroPath}`);
      restore(site, token);
      return { ok: false, route, sections, failures };
    }

    // 7. Optional nav link.
    if (args.addToNav) {
      addNavLink(site, args.navText ?? titleFromRoute(route), route);
    }

    // 8. Lightweight verify: every blueprint section present in site.json for the route,
    //    and the page .astro exists.
    const manifest: SiteManifest = loadSite(site);
    const page = manifest.pages.find((p) => p.route === route);
    if (!page) failures.push(`route ${route} not found in site.json after compose`);
    else {
      for (const name of sections) {
        if (!page.sections.some((s) => s.name === name)) {
          failures.push(`${name} missing from site.json for ${route}`);
        }
      }
    }
    if (!fs.existsSync(astroPath)) failures.push(`page .astro missing: ${astroPath}`);

    if (failures.length > 0) {
      restore(site, token);
      return { ok: false, route, sections, failures };
    }

    return { ok: true, route, sections, siteReport: { blockerCount: 0 }, failures };
  } catch (err) {
    // Any throw anywhere in the pipeline → roll back to the pre-compose snapshot.
    restore(site, token);
    return { ok: false, route, sections, failures: [...failures, (err as Error).message] };
  }
}

/** Read the business/site name from labels.json if present (for SEO meta quality). */
function readSiteName(site: SiteRef): string {
  const labelsPath = path.join(site.dir, "labels.json");
  if (fs.existsSync(labelsPath)) {
    try {
      const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8")) as { site?: { name?: string } };
      if (labels.site?.name) return labels.site.name;
    } catch {
      /* malformed labels.json — fall through to the default */
    }
  }
  return "our business";
}
```

> **Note on `generatePageMeta` import:** it is imported for parity with the rest of the edit layer and is available as a deterministic fallback if a future revision wants a no-LLM path. It is not called in the happy path (the LLM meta is preferred). If `pnpm lint` flags it as unused, remove the import — do NOT keep a dead import to satisfy a comment. (Decide at implementation time based on the lint result; the plan's intent is: LLM meta is the source of truth, `generatePageMeta` is the documented fallback.)

### `src/ugc/index.ts`
```ts
// UGC content-page composition — composePage() builds a full on-brand content page
// (blog / local-seo / recipe / event / challenge) from a single brief.
export { composePage } from "./compose.ts";
export type { ComposePageArgs, ComposePageResult } from "./compose.ts";
export { BLUEPRINTS, slugify, routeOf, titleFromRoute } from "./blueprints.ts";
export type { ContentKind } from "./blueprints.ts";
```

### Gates
```bash
packages/clone-engine/node_modules/.bin/tsc --noEmit
cd packages/clone-engine && pnpm lint
```
Expected: `tsc` exits 0 (no output). `pnpm lint` passes (resolve the `generatePageMeta` import per the note above — drop it if flagged unused).

### Commit
```bash
cd packages/clone-engine
git add src/ugc/compose.ts src/ugc/index.ts
git commit -m "feat(ugc): composePage orchestrator + barrel (T1)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```

---

## T2 — Integration test + public exports

### Files
- CREATE `test/ugc/compose.test.ts`
- EDIT `src/index.ts` (add the public exports)

### Step 1 (RED): the integration test

`test/ugc/compose.test.ts` (mirrors the fixture/guard/fakeChat setup from `test/edit/scenario/generate.test.ts`):
```ts
/**
 * compose.test.ts — integration test for composePage (UGC content-page creation).
 *
 * Proves: from a single brief, composePage builds a complete on-brand page —
 *   - a new page exists at the sanitized route with EXACTLY the blueprint's sections, in order;
 *   - every generated section is on-contract (present in site.json + the page .astro);
 *   - the page .astro carries the LLM-quality SEO title + description;
 *   - a nav link is added when addToNav=true;
 *   - the homepage is untouched;
 *   - a FAILED compose (a section's oracle fails) leaves the site BYTE-IDENTICAL (atomic rollback).
 *
 * LLM is mocked with fakeChat. Gated by ASTRO_MODULES (needs a real Astro build for the
 * per-section oracle inside generateSection).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { project } from "../../src/project.ts";
import { composePage } from "../../src/ugc/compose.ts";
import { BLUEPRINTS, routeOf } from "../../src/ugc/blueprints.ts";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../../src/edit/types.ts";
import type { SiteManifest } from "../../src/types.ts";

function editableHash(siteDir: string): string {
  const files: string[] = [];
  const walk = (abs: string, rel: string) => {
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const c of fs.readdirSync(abs).sort()) walk(path.join(abs, c), path.join(rel, c));
    else files.push(rel);
  };
  const push = (rel: string) => walk(path.join(siteDir, rel), rel);
  push("site.json");
  push(path.join("astro", "brand.json"));
  push(path.join("astro", "src"));
  push(path.join("astro", "public", "assets"));
  push("assets");
  const h = crypto.createHash("sha256");
  for (const rel of files.sort()) {
    h.update(rel); h.update("\0");
    h.update(fs.readFileSync(path.join(siteDir, rel))); h.update("\0");
  }
  return h.digest("hex");
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN = path.join(dir, "../golden/speakeasy");
const WIDTH = 1440;
const MODEL = "mock-model";

function findAstroModules(): string | null {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(REPO, "page-clone-spike/out-project-page/astro/node_modules"),
    path.join(PKG, "node_modules"),
    path.join(REPO, "node_modules"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}
const ASTRO_MODULES = findAstroModules();

/** A ChatFn that returns queued responses in order (one per call). */
function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

async function projectFixture(prefix: string): Promise<{ out: string; site: SiteRef }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  return { out, site: { dir: out } };
}

/**
 * Build the fakeChat response queue for a compose: outline first, then one copy fill per
 * blueprint role (each fill is the FULL slot object for that role's template), then the SEO
 * meta object last. The copy fills below cover the roles used by the blog + local-seo blueprints.
 */
function copyFillFor(role: string): Record<string, unknown> {
  switch (role) {
    // hero slotSchema: { eyebrow?, headline, subcopy, primaryCta, secondaryCta? }
    case "hero":
      return { eyebrow: "", headline: "Best CrossFit in Brooklyn", subcopy: "Beginner-friendly coaching.", primaryCta: "Book a free class" };
    // content-block slotSchema: { heading, body, cta? }
    case "content-block":
      return { heading: "Why It Works", body: "Structured, scalable workouts for every level.", cta: "Learn more" };
    // media-block slotSchema: { eyebrow?, heading, body, cta }
    case "media-block":
      return { eyebrow: "", heading: "See It In Action", body: "A look inside a typical class.", cta: "Watch" };
    // feature-grid slotSchema: { heading, features: [EXACTLY 3 × {title, body}] }
    case "feature-grid":
      return { heading: "What You Get", features: [
        { title: "Coaching", body: "Certified coaches every session." },
        { title: "Community", body: "Train with people who push you." },
        { title: "Schedule", body: "Classes morning to night." },
      ] };
    // faq slotSchema: { heading, items: [EXACTLY 6 × {question, answer}] }
    case "faq":
      return { heading: "Questions", items: [
        { question: "Do I need experience?", answer: "No — every workout scales to you." },
        { question: "What should I bring?", answer: "Just water and a good attitude." },
        { question: "How long is a class?", answer: "About an hour, warm-up to cool-down." },
        { question: "Is there parking?", answer: "Yes, free street and lot parking." },
        { question: "Can I try before joining?", answer: "Your first class is free." },
        { question: "What are the hours?", answer: "Open early morning through evening, 7 days." },
      ] };
    // cta-band slotSchema: { eyebrow?, headline, subcopy, buttonLabel }
    case "cta-band":
      return { eyebrow: "Ready?", headline: "Start This Week", subcopy: "Your first class is free.", buttonLabel: "Book now" };
    // stats-band slotSchema: { items: [EXACTLY 4 × {number, label}] }
    case "stats-band":
      return { items: [
        { number: "500+", label: "Members" },
        { number: "12", label: "Coaches" },
        { number: "7", label: "Days a week" },
        { number: "4.9", label: "Avg rating" },
      ] };
    // lead-form slotSchema: { heading, subcopy, placeholder, cta }
    case "lead-form":
      return { heading: "Join The Challenge", subcopy: "Sign up in seconds.", placeholder: "Your email", cta: "Sign up" };
    default:
      return {};
  }
}

/**
 * The slot field names above are VERIFIED against each template's Zod slotSchema in
 * src/edit/templates.ts (hero, content-block, media-block, feature-grid [3 items], faq
 * [6 items], cta-band, stats-band [4 items], lead-form). The tuple-arity ones (feature-grid=3,
 * faq=6, stats-band=4) MUST have exactly that many entries or llmJson rejects the fill.
 * If templates.ts changes, update these fills — a mismatch surfaces as a section failure in
 * `result.failures`, not a silent pass.
 */
function composeQueue(kind: keyof typeof BLUEPRINTS, meta: { title: string; description: string }): string[] {
  const roles = BLUEPRINTS[kind];
  const outline = { sectionBriefs: roles.map((r, i) => `Coherent brief ${i} for ${r}.`) };
  return [
    JSON.stringify(outline),
    ...roles.map((r) => JSON.stringify(copyFillFor(r))),
    JSON.stringify(meta),
  ];
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { if (browser) await browser.close(); });

const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("composePage — UGC content page creation", () => {
  it("composes a blog page: blueprint sections in order, SEO meta, nav link, homepage untouched", async () => {
    const { out, site } = await projectFixture("compose-blog-");
    cleanup.add(out);

    const META = { title: "Best CrossFit Gym in Brooklyn for Beginners", description: "New to CrossFit? Our Brooklyn gym coaches beginners from day one. Book a free class." };
    const chat = fakeChat(composeQueue("blog", META));

    const manifestBefore = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const homeSectionsBefore = manifestBefore.pages.find((p) => p.route === "/")!.sections.length;

    const result = await composePage(
      site,
      { route: "/blog/best-crossfit-brooklyn/", kind: "blog", brief: "Best CrossFit gym in Brooklyn for beginners", addToNav: true, navText: "Blog" },
      chat,
      MODEL,
      browser,
      { width: WIDTH },
    );

    expect(result.ok, `compose failed: ${result.failures.join(" | ")}`).toBe(true);
    const route = routeOf("/blog/best-crossfit-brooklyn/");
    expect(result.route).toBe(route);
    expect(result.sections.length).toBe(BLUEPRINTS.blog.length);

    // The new page exists in site.json with the blueprint's sections in order.
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const page = manifest.pages.find((p) => p.route === route);
    expect(page, "composed page must be in site.json").toBeTruthy();
    expect(page!.sections.map((s) => s.role)).toEqual(BLUEPRINTS.blog);

    // Homepage untouched.
    expect(manifest.pages.find((p) => p.route === "/")!.sections.length).toBe(homeSectionsBefore);

    // The page .astro imports/includes every generated component + carries the SEO meta.
    const slug = route.replace(/^\/|\/$/g, "");
    const astro = fs.readFileSync(path.join(out, "astro/src/pages", `${slug}.astro`), "utf8");
    for (const name of result.sections) {
      expect(astro, `page astro must include ${name}`).toContain(`<${name} />`);
    }
    expect(astro).toContain(`<title>${META.title}</title>`);
    expect(astro).toContain(META.description);

    // Nav link added.
    const navSection = manifest.pages.flatMap((p) => p.sections).find((s) => s.role === "navbar" || /nav/i.test(s.name));
    expect(navSection, "a nav section must exist").toBeTruthy();
    const navSrc = fs.readFileSync(path.join(out, navSection!.file), "utf8");
    expect(navSrc).toContain(`href="${route}"`);
  }, 600_000);

  it("composes a local-seo page (different blueprint: feature-grid + faq)", async () => {
    const { out, site } = await projectFixture("compose-seo-");
    cleanup.add(out);

    const META = { title: "CrossFit Gym Near Park Slope", description: "The top-rated CrossFit gym serving Park Slope. Coaching, community, and classes all day." };
    const chat = fakeChat(composeQueue("local-seo", META));

    const result = await composePage(
      site,
      { route: "/gyms/park-slope/", kind: "local-seo", brief: "CrossFit gym serving Park Slope, Brooklyn" },
      chat,
      MODEL,
      browser,
      { width: WIDTH },
    );

    expect(result.ok, `compose failed: ${result.failures.join(" | ")}`).toBe(true);
    const route = routeOf("/gyms/park-slope/");
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const page = manifest.pages.find((p) => p.route === route)!;
    expect(page.sections.map((s) => s.role)).toEqual(BLUEPRINTS["local-seo"]);
    // addToNav defaulted false → no nav link for this route.
    const navSection = manifest.pages.flatMap((p) => p.sections).find((s) => s.role === "navbar" || /nav/i.test(s.name))!;
    const navSrc = fs.readFileSync(path.join(out, navSection.file), "utf8");
    expect(navSrc).not.toContain(`href="${route}"`);
  }, 600_000);

  it("a failed compose leaves the site BYTE-IDENTICAL (atomic rollback)", async () => {
    const { out, site } = await projectFixture("compose-fail-");
    cleanup.add(out);

    const beforeHash = editableHash(out);

    // Outline succeeds; the FIRST section fill is invalid JSON → generateSection's llmJson
    // retries then throws → composePage catches, restores, returns ok:false.
    const chat = fakeChat([
      JSON.stringify({ sectionBriefs: ["a", "b", "c", "d", "e"] }),
      "NOT VALID JSON — force the first section to fail",
    ]);

    const result = await composePage(
      site,
      { route: "/blog/doomed/", kind: "blog", brief: "This compose must fail and roll back" },
      chat,
      MODEL,
      browser,
      { width: WIDTH },
    );

    expect(result.ok, "a failing compose must report ok:false").toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    // BYTE-IDENTICAL: no new page, no leftover components, no site.json mutation.
    expect(editableHash(out), "a failed compose must leave the site byte-identical").toBe(beforeHash);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    expect(manifest.pages.some((p) => p.route === routeOf("/blog/doomed/"))).toBe(false);
  }, 600_000);
});
```

> **Implementation note for the worker:** the `copyFillFor` fills are already verified against `src/edit/templates.ts` (see the per-case comments). Cross-check them once before running — the tuple-arity schemas are the easy trap: `feature-grid` needs exactly 3 `features`, `faq` needs exactly 6 `items` (`{question, answer}`), `stats-band` needs exactly 4 `items` (`{number, label}`). These match the fills that `test/edit/scenario/generate.test.ts` uses for the overlapping roles. If a fill's fields are wrong, that section fails its oracle and `result.failures` will name it.

### Step 2: RED run
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/ugc/compose.test.ts
```
Expected (before `src/index.ts` edit — this test imports `composePage` from `src/ugc/compose.ts` directly, so it will actually RUN against the T1 source). The likely first red is a **copy-fill field mismatch** surfaced as a section failure, or a genuine green if T1 is correct. Treat the first run as the discovery of any slot-schema mismatch; fix `copyFillFor` field names against templates.ts until the two happy-path tests pass and the rollback test passes.

If `ASTRO_MODULES` is not found, the whole describe is skipped — verify at least that the module resolves and the file typechecks (T3 covers the non-skipped guarantee on a machine with astro installed).

### Step 3 (GREEN): wire public exports into `src/index.ts`

Add after the subsystem-F block (around `src/index.ts:44`):
```ts
// UGC content-page composition — composePage builds a full on-brand content page from a brief.
export { composePage, BLUEPRINTS as UGC_BLUEPRINTS } from "./ugc/index.ts";
export type { ComposePageArgs, ComposePageResult, ContentKind } from "./ugc/index.ts";
```

> **Naming note:** the spec asks to export `composePage`, `ContentKind`, `ComposePageArgs`, `ComposePageResult` from `src/index.ts`. `BLUEPRINTS` is aliased to `UGC_BLUEPRINTS` at the top level only to avoid any future top-level name collision; the un-aliased `BLUEPRINTS` remains available via the `ugc` barrel. If a top-level `BLUEPRINTS` is preferred and there is no collision, export it unaliased — decide at implementation time by checking for an existing `BLUEPRINTS` export (there is none today).

Verify the exports typecheck:
```bash
packages/clone-engine/node_modules/.bin/tsc --noEmit
```
Expected: exit 0.

### Step 4: run the ugc suite green
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/ugc/
```
Expected (on a machine with astro modules):
```
✓ test/ugc/blueprints.test.ts (11)
✓ test/ugc/compose.test.ts (3)
Test Files  2 passed (2)
```
On a machine WITHOUT astro modules, `compose.test.ts` is skipped (0 run) and `blueprints.test.ts` passes — that is an acceptable local state; CI with astro is the real gate.

### Step 5: commit
```bash
cd packages/clone-engine
git add test/ugc/compose.test.ts src/index.ts
git commit -m "test(ugc): composePage integration test + public exports (T2)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```

---

## T3 — Full suite green + typecheck + lint

No new source. This task is the final verification gate: the whole test suite passes, types are clean, lint is clean.

### Step 1: full typecheck
```bash
packages/clone-engine/node_modules/.bin/tsc --noEmit
```
Expected: no output, exit 0.

### Step 2: lint
```bash
cd packages/clone-engine && pnpm lint
```
Expected: clean. Fix any findings in the ugc/ files (e.g. remove an unused `generatePageMeta` import if it was left in). Do NOT suppress with disable-comments unless the rule is genuinely wrong for the case.

### Step 3: the ugc suite
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/ugc/
```
Expected: `blueprints.test.ts` passes; `compose.test.ts` passes (with astro) or is skipped (without).

### Step 4: the neighboring edit scenario suite (no regressions)
`composePage` calls `addPage`, `removeSection`, `generateSection`, `addNavLink`, `snapshot`/`restore` — it must not have required any change to them. Prove the existing edit scenario tests still pass:
```bash
cd packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/
```
Expected: all pass (unchanged) — `composePage` is purely additive.

### Step 5: commit (only if any fixes were made in this task)
```bash
cd packages/clone-engine
git add -A src/ugc test/ugc src/index.ts
git commit -m "chore(ugc): finalize composePage — suite green, typecheck + lint clean (T3)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CqeXo3mKGQV1WFcuoAyzt8"
```
If T3 required no code changes, skip the commit and simply report the passing gates.

---

## Design decisions & rationale (read before implementing)

1. **Why `removeSection` after `addPage`?** `addPage` is the only page-scaffolding primitive and it always clones a template page's sections (it can't emit a bare page). The blueprint defines the exact section set, so the composed page must start empty. Removing the cloned sections via `removeSection` (which also strips imports/includes and cleans `site.json`) leaves a valid, buildable, empty page for `generateSection` to fill. This reuses existing verified ops rather than adding a new "empty page" primitive — the leverage-first choice.

2. **Why the page `.astro` source for SEO, not dist HTML?** dist is a regenerable build artifact, is NOT covered by snapshot/restore (`history.ts:6`), and is overwritten on every `astro build`. Injecting there would be lost on the next build and invisible to rollback. The page `.astro` head is the durable, snapshotted source of truth — `applyPageMeta` upgrades the title + description that `addPage` already stamped in. This is a deliberate, documented divergence from the spec's literal "dist HTML" wording, made for correctness (per the repo's "correctness wins over convention" rule).

3. **Why one outline call before N fills?** Independent per-section LLM fills contradict each other (different tone, repeated claims, inconsistent offers). A single planning call produces N coherent, ordered briefs; each is then handed to `generateSection`, which does its own schema-constrained copy fill. Total LLM calls: `1 outline + N section fills + 1 SEO = 2 + N`.

4. **Atomicity:** one snapshot at the top, one restore on any failure path (section failure, SEO throw, verify assertion, any thrown error). The rollback test proves byte-identical restoration using the same `editableHash` oracle the generate/apply tests use.

5. **Lightweight verify only.** Per the spec, `composePage`'s own final check is structural (sections in `site.json`, page `.astro` exists). The heavy per-section pixel/build oracle already ran inside each `generateSection` call, so re-running a full site verify would be redundant. `siteReport.blockerCount` is `0` on success by construction (every section passed its own oracle).

## Definition of done
- `src/ugc/{blueprints,compose,index}.ts` exist and are the only new source files.
- `test/ugc/{blueprints,compose}.test.ts` exist; blueprints unit tests pass everywhere, compose integration tests pass under `ASTRO_MODULES`.
- `composePage`, `ContentKind`, `ComposePageArgs`, `ComposePageResult` are exported from `src/index.ts`.
- `tsc --noEmit` clean, `pnpm lint` clean.
- `test/edit/` still green (no regressions in the primitives composePage calls).
- Each task committed with the explicit `git add` paths above.
```
