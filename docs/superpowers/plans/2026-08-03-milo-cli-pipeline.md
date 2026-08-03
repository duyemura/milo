# Milo Unified CLI + Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `milo learn` and `milo clone` commands, extract `generateSite` from `runIntake`, and introduce a typed `MiloJob` schema — without touching the clone engine internals.

**Architecture:** `runLearn` handles all research/crawl work and returns structured data; `runIntake` becomes a thin backward-compat wrapper that calls `runLearn` then `generateSite`. The new `milo clone` CLI command is a subprocess wrapper over the existing `clone-engine/src/cli.ts build-auto` — the engine is never touched. A `MiloJob` Zod schema in `@milo/schema` becomes the typed contract between CLI and admin.

**Tech Stack:** TypeScript, Zod, Node.js child_process, Vitest — all already in use.

**Clone safety rule:** The `packages/clone-engine/` directory is not touched in any task. Clone continues to work after every commit. Any step that changes the admin runner is clearly marked and is the last step.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `packages/schema/src/jobs.ts` | **CREATE** | `MiloJob`, `LearnJob`, `CloneJob`, `DeployJob` Zod schemas |
| `packages/schema/src/index.ts` | **MODIFY** | Add export for `jobs.ts` |
| `packages/intake/src/intake.ts` | **MODIFY** | Extract `generateSite` into `runLearn`; keep `runIntake` as backward-compat wrapper |
| `packages/intake/src/index.ts` | **MODIFY** | Export `runLearn` + `RunLearnResult` alongside existing exports |
| `packages/intake/test/intake.test.ts` | **MODIFY** | Add `runLearn` test; keep existing `runIntake` test passing |
| `apps/cli/src/milo.ts` | **MODIFY** | Add `case "learn":` and `case "clone":` switch branches |
| `apps/admin/src/jobs/runner.ts` | **MODIFY** | Update template seed from `milo intake` → `milo learn` + explicit generate step (final task, low-risk) |

**Not touched:** `packages/clone-engine/` (zero changes), `apps/renderer/`, `packages/publish/`.

---

## Task 1: Add MiloJob schema to `@milo/schema`

**Files:**
- Create: `packages/schema/src/jobs.ts`
- Modify: `packages/schema/src/index.ts`

- [ ] **Step 1.1: Write the file**

```typescript
// packages/schema/src/jobs.ts
import { z } from "zod";

export const LearnJob = z.object({
  type: z.literal("learn"),
  url: z.string().url(),
});

export const CloneJob = z.object({
  type: z.literal("clone"),
  url: z.string().url(),
  templateId: z.string().optional(),
  refreshDocs: z.boolean().default(false),
  docsSlug: z.string().optional(),
  includeUgc: z.boolean().default(false),
  ugcLimit: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
});

export const DeployJob = z.object({
  type: z.literal("deploy"),
  slug: z.string(),
  env: z.enum(["staging", "production"]),
  versionId: z.string().optional(),
});

export const MiloJob = z.discriminatedUnion("type", [LearnJob, CloneJob, DeployJob]);
export type MiloJob = z.infer<typeof MiloJob>;
export type LearnJob = z.infer<typeof LearnJob>;
export type CloneJob = z.infer<typeof CloneJob>;
export type DeployJob = z.infer<typeof DeployJob>;
```

- [ ] **Step 1.2: Export from the package index**

In `packages/schema/src/index.ts`, append this line at the end:

```typescript
export { MiloJob, LearnJob, CloneJob, DeployJob } from "./jobs.ts";
export type { MiloJob as MiloJobType, LearnJob as LearnJobType, CloneJob as CloneJobType, DeployJob as DeployJobType } from "./jobs.ts";
```

- [ ] **Step 1.3: Verify the types compile**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm --filter @milo/schema exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 1.4: Commit**

```bash
git add packages/schema/src/jobs.ts packages/schema/src/index.ts
git commit -m "feat(schema): add MiloJob discriminated union (LearnJob, CloneJob, DeployJob)"
```

---

## Task 2: Extract `runLearn` from `runIntake`

This is the core refactor. `runLearn` does everything `runIntake` currently does except calling `generateSite`. `runIntake` becomes a thin wrapper: `runLearn` + `generateSite` + write gym.json. Clone is untouched.

**Files:**
- Modify: `packages/intake/src/intake.ts`
- Modify: `packages/intake/src/index.ts`

- [ ] **Step 2.1: Write the failing test for `runLearn`**

Add this describe block at the **end** of `packages/intake/test/intake.test.ts` (before the last closing brace if any):

```typescript
import { runLearn } from "../src/intake.ts";

describe("runLearn", () => {
  it("writes crawl bundle + context.json + business.json but NOT gym.json", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    // 3 page classifications + BUSINESS + CONTEXT (no GYM call)
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    // crawl bundle written
    const crawlDir = path.join(out, "crawl");
    expect(JSON.parse(await readFile(path.join(crawlDir, "identity.json"), "utf8"))).toHaveProperty("found");
    expect(JSON.parse(await readFile(path.join(crawlDir, "brand.json"), "utf8"))).toHaveProperty("colors");
    expect(JSON.parse(await readFile(path.join(crawlDir, "pages.json"), "utf8"))).toHaveProperty("pages");

    // LLM doc outputs written
    expect(await readFile(path.join(out, "context.json"), "utf8")).toBeTruthy();
    expect(await readFile(path.join(out, "business.json"), "utf8")).toBeTruthy();

    // Markdown docs written
    expect(await readFile(path.join(out, "context.md"), "utf8")).toMatch(/iron anchor/i);
    expect(await readFile(path.join(out, "business.md"), "utf8")).toMatch(/iron anchor/i);

    // gym.json NOT written — generateSite was never called
    await expect(readFile(path.join(out, "gym.json"), "utf8")).rejects.toThrow();
  });

  it("returns structured data usable by generateSite", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);

    const result = await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    expect(result.context).toHaveProperty("brandVoice");
    expect(result.business).toHaveProperty("techStack");
    expect(result.identity).toHaveProperty("found");
    expect(result.pageDocs.length).toBeGreaterThan(0);
    expect(result.brand).toHaveProperty("colors");
  });
});
```

- [ ] **Step 2.2: Run the test to confirm it fails**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm --filter @milo/intake exec vitest run --no-file-parallelism test/intake.test.ts 2>&1 | tail -20
```

Expected: FAIL — `runLearn is not exported from ../src/intake.ts`

- [ ] **Step 2.3: Implement `runLearn` in `intake.ts`**

At the end of `packages/intake/src/intake.ts`, before the existing `export async function runIntake`:

1. Add a `RunLearnResult` interface:

```typescript
export interface RunLearnResult {
  context: Record<string, unknown>;
  business: Record<string, unknown>;
  identity: IdentityCrawl;
  brand: BrandCrawl;
  pageDocs: PageDocument[];
  gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[];
  placeholderArchetypes: string[];
  budgets: Map<string, string>;
  integrations: Record<string, unknown>;
}
```

2. Rename the existing `export async function runIntake` to `export async function runLearn` and change its return type from `Promise<void>` to `Promise<RunLearnResult>`.

3. Remove lines 385–407 (the `generateSite` call and all four `writeJson` calls after it). Replace them with:

```typescript
  // Write docs in both JSON (template compat) and Markdown (new format)
  await writeJson(path.join(opts.outDir, "context.json"), context);
  await writeJson(path.join(opts.outDir, "business.json"), business);
  await writeJson(path.join(opts.outDir, "integrations.json"), integrations);
  await writeFile(path.join(opts.outDir, "context.md"), contextToMarkdown(opts.gymName, context), "utf8");
  await writeFile(path.join(opts.outDir, "business.md"), businessToMarkdown(opts.gymName, business), "utf8");

  console.log(`[learn] Wrote context.json + business.json + context.md + business.md to ${opts.outDir}`);

  return { context, business, identity, brand, pageDocs, gmbAssets, placeholderArchetypes, budgets, integrations };
```

4. Add the two markdown helpers above `runLearn` (near the top of the helpers section):

```typescript
function contextToMarkdown(gymName: string, ctx: Record<string, unknown>): string {
  const lines: string[] = [`# Context: ${gymName}`, ""];
  const icp = ctx["icp"] as Record<string, unknown> | undefined;
  if (icp) {
    lines.push("## Ideal customer profile");
    if (icp["fitnessLevel"]) lines.push(`- Fitness level: ${icp["fitnessLevel"]}`);
    if (icp["ageRange"]) lines.push(`- Age range: ${icp["ageRange"]}`);
    if (Array.isArray(icp["primaryGoals"]) && icp["primaryGoals"].length) lines.push(`- Goals: ${icp["primaryGoals"].join(", ")}`);
    lines.push("");
  }
  const voice = ctx["brandVoice"] as Record<string, unknown> | undefined;
  if (voice) {
    lines.push("## Brand voice");
    if (voice["tone"]) lines.push(`- Tone: ${voice["tone"]}`);
    if (voice["communicationStyle"]) lines.push(`- Style: ${voice["communicationStyle"]}`);
    if (Array.isArray(voice["emphasizes"]) && voice["emphasizes"].length) lines.push(`- Emphasizes: ${voice["emphasizes"].join(", ")}`);
    if (Array.isArray(voice["avoids"]) && voice["avoids"].length) lines.push(`- Avoids: ${voice["avoids"].join(", ")}`);
    lines.push("");
  }
  if (ctx["primaryOffer"]) lines.push(`**Primary offer:** ${ctx["primaryOffer"]}\n`);
  if (ctx["pricingTier"]) lines.push(`**Pricing tier:** ${ctx["pricingTier"]}\n`);
  return lines.join("\n");
}

function businessToMarkdown(gymName: string, biz: Record<string, unknown>): string {
  const lines: string[] = [`# Business: ${gymName}`, ""];
  const tech = biz["techStack"] as Record<string, unknown> | undefined;
  if (tech) {
    lines.push("## Tech stack");
    if (tech["websiteBuilder"]) lines.push(`- Website builder: ${tech["websiteBuilder"]}`);
    if (tech["gymSoftware"]) lines.push(`- Gym software: ${tech["gymSoftware"]}`);
    if (tech["bookingMethod"]) lines.push(`- Booking: ${tech["bookingMethod"]}`);
    lines.push("");
  }
  const mkt = biz["marketingMaturity"] as Record<string, unknown> | undefined;
  if (mkt) {
    lines.push("## Marketing");
    if (Array.isArray(mkt["socialPlatforms"]) && mkt["socialPlatforms"].length) lines.push(`- Social: ${mkt["socialPlatforms"].join(", ")}`);
    if (mkt["runsPaidAds"]) lines.push(`- Runs paid ads: ${mkt["runsPaidAds"]}`);
    if (mkt["hasEmailList"]) lines.push(`- Email list: ${mkt["hasEmailList"]}`);
    lines.push("");
  }
  if (biz["assessment"]) lines.push(`**Assessment:** ${biz["assessment"]}\n`);
  return lines.join("\n");
}
```

5. Add a new `runIntake` as a backward-compat wrapper **after** `runLearn`:

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
  await writeJson(path.join(opts.outDir, "gym.json"), gym);
  console.log(`[intake] Wrote gym.json to ${opts.outDir}`);
}
```

Also rename the interface at the top of the file: add `export type RunLearnOptions = RunIntakeOptions;` so both names work.

- [ ] **Step 2.4: Run the tests**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm --filter @milo/intake exec vitest run --no-file-parallelism test/intake.test.ts 2>&1 | tail -30
```

Expected: ALL tests pass — both the new `runLearn` tests and the existing `runIntake` test.

- [ ] **Step 2.5: Update intake package exports**

In `packages/intake/src/index.ts`, add exports alongside the existing ones:

```typescript
export { runLearn } from "./intake.ts";
export type { RunLearnResult, RunLearnOptions } from "./intake.ts";
```

(Keep `export { runIntake }` and `export type { RunIntakeOptions }` as-is for compat.)

- [ ] **Step 2.6: Verify the full intake test suite still passes**

```bash
pnpm --filter @milo/intake exec vitest run --no-file-parallelism 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 2.7: Commit**

```bash
git add packages/intake/src/intake.ts packages/intake/src/index.ts packages/intake/test/intake.test.ts
git commit -m "feat(intake): extract runLearn — decouples research from site generation; runIntake kept as backward-compat wrapper"
```

---

## Task 3: Add `milo learn` command to the CLI

`milo intake` continues working unchanged. `milo learn` is the new command that calls `runLearn` only (no gym.json, no generateSite).

**Files:**
- Modify: `apps/cli/src/milo.ts`

- [ ] **Step 3.1: Add `case "learn":` before the existing `case "intake":`**

In `apps/cli/src/milo.ts`, add this block before line 115 (`case "intake":`):

```typescript
  case "learn": {
    const learnArgs = subcommand ? [subcommand, ...rest] : rest;
    try {
      const websiteUrl = requireFlag("url", learnArgs);
      if (!/^https?:\/\//i.test(websiteUrl)) {
        console.error("--url must be a valid http or https URL");
        process.exit(1);
      }
      const gymName = requireFlag("name", learnArgs);
      const city = requireFlag("city", learnArgs);
      const state = requireFlag("state", learnArgs);
      const country = flag("country", learnArgs) ?? "US";
      const outDir = path.resolve(flag("out", learnArgs) ?? "./learn-output");
      const placesKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!placesKey) { console.error("GOOGLE_PLACES_API_KEY is required for learn"); process.exit(1); }
      const openrouterKey = process.env.OPENROUTER_API_KEY;
      if (!openrouterKey) { console.error("OPENROUTER_API_KEY is required for learn"); process.exit(1); }

      const { runLearn, createRealPlacesClient, createRealPageFetcher, loadCrawlRules } = await import("@milo/intake");
      const { chatCompletion } = await import("@milo/llm");
      const llmConfig = {
        provider: "openrouter" as const,
        openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        openrouterApiKey: openrouterKey,
      };

      const rulesPath = flag("rules", learnArgs);
      const result = await runLearn({
        url: websiteUrl,
        gymName,
        city,
        state,
        country,
        outDir,
        maxPages: Number(flag("max-pages", learnArgs) ?? 25),
        includeUgc: learnArgs.includes("--include-ugc"),
        concurrency: Number(flag("concurrency", learnArgs) ?? 3),
        skipCrawl: learnArgs.includes("--skip-crawl"),
        places: createRealPlacesClient(placesKey),
        fetcher: createRealPageFetcher(),
        chat: (o) => chatCompletion(o, llmConfig),
        capableModel: process.env.MILO_CAPABLE_MODEL ?? "anthropic/claude-sonnet-4-6",
        fastModel: process.env.MILO_FAST_MODEL ?? "google/gemini-2.5-flash",
        discoveredAt: new Date().toISOString(),
        ...(rulesPath ? { rules: loadCrawlRules(path.resolve(rulesPath)) } : {}),
      });
      console.log(`[learn] Done. ${result.pageDocs.length} pages documented. Docs at ${outDir}`);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }
```

- [ ] **Step 3.2: Update the usage line in the `default:` case**

Find:
```typescript
    console.log("Usage: milo <studio|intake|generate|build|publish> [flags]");
```

Replace with:
```typescript
    console.log("Usage: milo <studio|learn|intake|generate|build|clone|publish> [flags]");
```

- [ ] **Step 3.3: Update the JSDoc comment at the top of the file**

Find the opening comment block and add:
```
 *   milo learn    --url <url> --name <gym-name> --city <city> --state <state> [--out <dir>]
```
after the `milo studio` line.

- [ ] **Step 3.4: Verify TypeScript compiles**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm --filter apps/cli exec tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3.5: Smoke test the `learn` command help path**

```bash
cd /Users/dan/pushpress/milo-ev2
node apps/cli/src/milo.ts learn 2>&1
```

Expected: `--url is required` error (env keys not set, correct behavior).

- [ ] **Step 3.6: Commit**

```bash
git add apps/cli/src/milo.ts
git commit -m "feat(cli): add milo learn command — research without site generation"
```

---

## Task 4: Add `milo clone` command as subprocess wrapper

`milo clone <url>` calls the existing `packages/clone-engine/src/cli.ts build-auto` subprocess. The engine is not modified. This gives the admin a stable `milo`-namespaced entry point for clone jobs.

**Files:**
- Modify: `apps/cli/src/milo.ts`

- [ ] **Step 4.1: Add `case "clone":` before the `default:` case**

```typescript
  case "clone": {
    // subcommand holds the URL when invoked as: milo clone <url> [flags]
    const cloneUrl = subcommand;
    const cloneArgs = rest;
    if (!cloneUrl || !/^https?:\/\//i.test(cloneUrl)) {
      console.error("Usage: milo clone <url> [--template <id>] [--refresh-docs] [--out <dir>]");
      process.exit(1);
    }

    // --refresh-docs: run learn first, blocking, then proceed with clone
    if (cloneArgs.includes("--refresh-docs")) {
      const learnName = requireFlag("name", cloneArgs);
      const learnCity = requireFlag("city", cloneArgs);
      const learnState = requireFlag("state", cloneArgs);
      const learnOut = path.resolve(flag("out", cloneArgs) ?? `./clone-output/${new URL(cloneUrl).hostname}`);
      const status = run("node", [
        fileURLToPath(import.meta.url),
        "learn",
        "--url", cloneUrl,
        "--name", learnName,
        "--city", learnCity,
        "--state", learnState,
        "--out", learnOut,
      ], ROOT);
      if (status !== 0) { console.error("[clone] learn step failed — aborting"); process.exit(status); }
    }

    const templateId = flag("template", cloneArgs);
    if (templateId) {
      // Template path: not yet implemented — placeholder for future spec
      console.error("--template is not yet implemented. Run milo intake + milo generate + milo build for template builds.");
      process.exit(1);
    }

    // DOM clone path: subprocess to the existing clone-engine CLI
    const cloneCli = path.join(ROOT, "packages/clone-engine/src/cli.ts");
    const outDir = flag("out", cloneArgs);
    const mode = flag("mode", cloneArgs) ?? "core";
    const engineArgs = [
      cloneCli,
      "build-auto",
      "--site", cloneUrl,
      "--mode", mode,
    ];
    if (outDir) engineArgs.push("--cwd", path.resolve(outDir));

    const extraArgs = cloneArgs.filter((a) =>
      !["--refresh-docs", "--out", "--mode"].includes(a) &&
      (outDir ? a !== outDir : true) &&
      (a !== mode),
    );
    engineArgs.push(...extraArgs);

    process.exit(run("node", engineArgs, ROOT));
  }
```

- [ ] **Step 4.2: Verify TypeScript compiles**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm --filter apps/cli exec tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4.3: Smoke test `milo clone` bad URL path**

```bash
cd /Users/dan/pushpress/milo-ev2
node apps/cli/src/milo.ts clone 2>&1
```

Expected: `Usage: milo clone <url> ...` error.

- [ ] **Step 4.4: Smoke test `milo clone` valid URL dispatches to engine**

```bash
cd /Users/dan/pushpress/milo-ev2
node apps/cli/src/milo.ts clone https://example.com --mode core 2>&1 | head -5
```

Expected: you see engine output (either a Playwright/Chromium launch message or an error from the engine about the site — either way it proves the subprocess dispatched).

- [ ] **Step 4.5: Commit**

```bash
git add apps/cli/src/milo.ts
git commit -m "feat(cli): add milo clone command — subprocess wrapper over clone-engine build-auto"
```

---

## Task 5: Update admin runner — template seed uses `milo learn`

The admin template seed currently calls `milo intake` then `milo generate`. After this task it calls `milo learn` then `milo generate` (identical behavior; `runIntake = runLearn + generateSite`, `milo generate` = generateSite standalone, so the net result is identical — `generateSite` runs once via `milo generate`).

**Clone seed is untouched.** Only the `case "seed":` branch for `site.seedType !== "clone"` changes.

**Files:**
- Modify: `apps/admin/src/jobs/runner.ts`

- [ ] **Step 5.1: Update the template seed branch**

Find in `apps/admin/src/jobs/runner.ts` at line 91:

```typescript
      await run([
        "intake",
        "--url", url,
        "--name", payload["name"],
        "--city", payload["city"],
        "--state", payload["state"],
        "--out", seedDir,
      ]);
      await run(["generate", "--docs", seedDir]);
```

Replace with:

```typescript
      await run([
        "learn",
        "--url", url,
        "--name", payload["name"],
        "--city", payload["city"],
        "--state", payload["state"],
        "--out", seedDir,
      ]);
      await run(["generate", "--docs", seedDir]);
```

(Only the command name changes: `"intake"` → `"learn"`. All flags are identical.)

- [ ] **Step 5.2: Verify TypeScript compiles**

```bash
cd /Users/dan/pushpress/milo-ev2
pnpm --filter apps/admin exec tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5.3: Confirm clone seed path is unchanged**

Check `runner.ts` line ~156 — the `runCloneSeed` function must still reference `packages/clone-engine/src/cli.ts` and `build-auto`. It must NOT have been modified.

```bash
grep -n "cloneCli\|build-auto\|clone-engine" /Users/dan/pushpress/milo-ev2/apps/admin/src/jobs/runner.ts
```

Expected output shows the engine path is unchanged.

- [ ] **Step 5.4: Commit**

```bash
git add apps/admin/src/jobs/runner.ts
git commit -m "feat(admin): template seed calls milo learn instead of milo intake"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Full CLI command set — `milo learn`, `milo clone`, `milo deploy`/`milo publish` (existing) — covered by Tasks 3 + 4
- [x] Intake refactor: `generateSite` decoupled, intake produces docs only — Task 2
- [x] Docs structure: context.md + business.md alongside context.json + business.json — Task 2, step 2.3
- [x] Job schema: `MiloJob` in `@milo/schema` — Task 1
- [x] Admin unification: template seed uses `milo learn` — Task 5
- [ ] `--refresh-docs` wires back to `milo learn` — covered in Task 4 step 4.1 (inline in the `clone` case)
- [ ] Clone + docs connection (Phase 2) — explicitly deferred, not in this plan
- [ ] `milo status` — explicitly deferred per spec

**Not in this plan (deferred):**
- Admin function-call refactor (subprocess → direct import) — separate plan, higher risk
- `milo clone --template <id>` full implementation — separate plan, template path v2
- Docs → clone Phase 2 (wiring context.md into section labeler)

**Type consistency:**
- `RunLearnOptions` is defined as `type RunLearnOptions = RunIntakeOptions` in intake.ts — consistent across Task 2 and Task 3
- `RunLearnResult` interface defined in Task 2 step 2.3 — used in Task 3 step 3.1 (`result.pageDocs.length`)
- `MiloJob` exported from `@milo/schema` in Task 1 — ready for admin adoption in a future plan
