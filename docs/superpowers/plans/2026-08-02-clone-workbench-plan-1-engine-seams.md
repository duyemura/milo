# Clone Workbench — Plan 1: Engine Event Seam + RunState + CLI bridge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the clone engine a structured, subscribable progress stream — a typed `EngineEvent`, a pure `RunState` projection, and a CLI `--emit-events` JSON-lines mode — so a UI (admin, Plan 2) can watch a clone run live instead of scraping `console.log`.

**Architecture:** Additive and optional. A new `src/events.ts` defines the event union + a pure reducer (`events` → `RunState`) + a line serializer. `buildSite` / `buildSiteAuto` gain an optional `onEvent` sink and emit at the existing `console.log` seam points (console output is retained). The CLI `build-auto` subcommand gains `--emit-events`, which attaches a sink writing marker-prefixed JSON lines to stdout. Nothing changes when no sink is attached, so the 0-px projection oracle and existing tests never regress.

**Tech Stack:** TypeScript (Node 24, `.ts` imports, node type-strip — no parameter properties, no enums), Vitest. Package: `@milo/clone-engine` (`packages/clone-engine`).

**Scope note:** This is Plan 1 of a sequence (spec: `docs/superpowers/specs/2026-08-02-clone-workbench-design.md`). It builds the CLONE-progress seam only. The edit events (`edit.*`) are *defined* in the union here but *emitted* in Plan 2 alongside the admin `POST /edits` route. Plan 2 = admin backend (teardown, runner event bridge, seed-generic routes). Plan 3 = UI workbench. Plan 4 = deploy.

**Branch/worktree:** Work on `page-clone-engine` in the main checkout (this session is its sole owner; the admin session stood down; E-v2 is isolated on `ev2-harvest`). Touch only `packages/clone-engine/src/{events.ts,orchestrate.ts,discover.ts,cli.ts,index.ts}` + `packages/clone-engine/test/events.test.ts`. Do NOT touch `apps/admin/*` (that's Plan 2) or `src/harvest/*` (E-v2's).

**Verification commands (use throughout):**
- Typecheck (real — the rtk proxy reports false-clean): `packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine`
- Unit tests (fast, non-browser): `pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism test/events.test.ts`

---

## File Structure

- **Create** `packages/clone-engine/src/events.ts` — the event union, `RunState`, the pure reducer/projection, and the line serializer. One responsibility: the event contract + its pure transforms. No I/O, no engine imports.
- **Create** `packages/clone-engine/test/events.test.ts` — pure unit tests for the reducer + serializer.
- **Modify** `packages/clone-engine/src/orchestrate.ts` — add `onEvent?: EngineEventSink` to `BuildSiteOpts`; emit page/assemble/report events in `buildSite`; emit run/discover events in `buildSiteAuto`.
- **Modify** `packages/clone-engine/src/discover.ts` — add optional `onProgress` to `DiscoverOpts`; fire it incrementally so the discovered-count grows live.
- **Modify** `packages/clone-engine/src/cli.ts` — add `--emit-events` to the `build-auto` subcommand.
- **Modify** `packages/clone-engine/src/index.ts` — re-export the events module.

---

## Task 1: The event contract — `events.ts` (pure, the keystone)

**Files:**
- Create: `packages/clone-engine/src/events.ts`
- Test: `packages/clone-engine/test/events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/clone-engine/test/events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  initialRunState,
  reduceRunState,
  projectRunState,
  eventToJsonLine,
  parseEventLine,
  EVENT_MARKER,
  type EngineEvent,
} from "../src/events.ts";

const CLONE_SEQUENCE: EngineEvent[] = [
  { type: "run.started", origin: "https://x.com" },
  { type: "discover.progress", coreFound: 2, ugcFound: 1, routes: ["/", "/about/", "/blog/p/"] },
  { type: "page.capture.started", route: "/" },
  { type: "page.capture.done", route: "/" },
  { type: "page.project.started", route: "/" },
  { type: "page.project.done", route: "/" },
  { type: "page.build.started", route: "/" },
  { type: "page.build.done", route: "/" },
  { type: "page.failed", route: "/about/", error: "capture timeout" },
  { type: "assemble.done", pages: 1, fullSiteDir: "/tmp/full-site" },
  { type: "report.done", reportJsonPath: "/tmp/r.json", reportHtmlPath: "/tmp/r.html" },
  { type: "run.completed", ok: 1, failed: 1 },
];

describe("reduceRunState", () => {
  it("projects a clone sequence into a coherent final state", () => {
    const s = projectRunState(CLONE_SEQUENCE);
    expect(s.status).toBe("built");
    expect(s.totalPages).toBe(3);
    expect(s.pagesCompleted).toBe(2); // one build.done + one failed
    expect(s.current).toBeNull();
    expect(s.discovered).toEqual(["/", "/about/", "/blog/p/"]);
    expect(s.failures).toEqual([{ route: "/about/", error: "capture timeout" }]);
  });

  it("marks a mid-run state while a page is building", () => {
    const partial = CLONE_SEQUENCE.slice(0, 7); // up to page.build.started "/"
    const s = projectRunState(partial);
    expect(s.status).toBe("building");
    expect(s.current).toEqual({ route: "/", phase: "build" });
    expect(s.pagesCompleted).toBe(0);
  });

  it("marks failed when every page failed (ok=0)", () => {
    const s = projectRunState([
      { type: "run.started", origin: "https://x.com" },
      { type: "run.completed", ok: 0, failed: 3 },
    ]);
    expect(s.status).toBe("failed");
  });

  it("initialRunState is a clean discovering state", () => {
    expect(initialRunState()).toEqual({
      status: "discovering",
      totalPages: 0,
      pagesCompleted: 0,
      current: null,
      discovered: [],
      failures: [],
    });
  });
});

describe("event line serializer", () => {
  it("round-trips every event through a marker-prefixed JSON line", () => {
    for (const e of CLONE_SEQUENCE) {
      const line = eventToJsonLine(e);
      expect(line.startsWith(EVENT_MARKER)).toBe(true);
      expect(parseEventLine(line)).toEqual(e);
    }
  });

  it("returns null for ordinary log lines (no marker)", () => {
    expect(parseEventLine("=== CAPTURE / ===")).toBeNull();
    expect(parseEventLine("")).toBeNull();
  });

  it("finds the event even when preceded by other stdout on the line", () => {
    const e: EngineEvent = { type: "page.build.done", route: "/" };
    expect(parseEventLine("leading noise " + eventToJsonLine(e))).toEqual(e);
  });

  it("returns null when the marker is present but the JSON is malformed", () => {
    expect(parseEventLine(EVENT_MARKER + "{not json")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism test/events.test.ts`
Expected: FAIL — `Cannot find module '../src/events.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/clone-engine/src/events.ts`:

```ts
/**
 * events.ts — the clone-engine progress event contract.
 *
 * Pure: no I/O, no engine imports. Defines the EngineEvent union, a pure RunState
 * reducer/projection (job_logs → RunState in the admin app), and a marker-prefixed
 * JSON-line serializer used by the CLI `--emit-events` mode so a parent process can
 * distinguish structured events from ordinary stdout.
 *
 * The seam is ADDITIVE: buildSite/buildSiteAuto emit these when an onEvent sink is
 * attached, and behave identically when it is not.
 */

export type EnginePhase = "capture" | "project" | "build";

export type EngineEvent =
  // --- clone lifecycle (emitted by buildSite / buildSiteAuto) ---
  | { type: "run.started"; origin: string }
  | { type: "discover.progress"; coreFound: number; ugcFound: number; routes: string[] }
  | { type: "page.capture.started"; route: string }
  | { type: "page.capture.done"; route: string }
  | { type: "page.project.started"; route: string }
  | { type: "page.project.done"; route: string }
  | { type: "page.build.started"; route: string }
  | { type: "page.build.done"; route: string }
  | { type: "page.failed"; route: string; error: string }
  | { type: "assemble.done"; pages: number; fullSiteDir: string }
  | { type: "report.done"; reportJsonPath: string; reportHtmlPath: string }
  | { type: "run.completed"; ok: number; failed: number }
  // --- edit lifecycle (DEFINED here; EMITTED in Plan 2 with POST /edits) ---
  | { type: "edit.started"; message: string }
  | { type: "edit.plan"; opsSummary: string }
  | { type: "edit.apply" }
  | { type: "edit.verify"; ok: boolean; correctionAttempt: number }
  | { type: "edit.rebuilt"; route: string; ms: number }
  | { type: "edit.done"; friendly: string }
  | { type: "edit.failed"; reason: string };

export type EngineEventSink = (e: EngineEvent) => void;

export interface RunState {
  status: "discovering" | "building" | "built" | "failed";
  totalPages: number;
  pagesCompleted: number;
  current: { route: string; phase: EnginePhase } | null;
  discovered: string[];
  failures: { route: string; error: string }[];
}

export function initialRunState(): RunState {
  return {
    status: "discovering",
    totalPages: 0,
    pagesCompleted: 0,
    current: null,
    discovered: [],
    failures: [],
  };
}

/** Pure fold of one event into the running state. No mutation. */
export function reduceRunState(state: RunState, e: EngineEvent): RunState {
  switch (e.type) {
    case "run.started":
      return initialRunState();
    case "discover.progress":
      return { ...state, totalPages: e.coreFound + e.ugcFound, discovered: e.routes };
    case "page.capture.started":
      return { ...state, status: "building", current: { route: e.route, phase: "capture" } };
    case "page.project.started":
      return { ...state, status: "building", current: { route: e.route, phase: "project" } };
    case "page.build.started":
      return { ...state, status: "building", current: { route: e.route, phase: "build" } };
    case "page.build.done":
      return { ...state, pagesCompleted: state.pagesCompleted + 1 };
    case "page.failed":
      return {
        ...state,
        pagesCompleted: state.pagesCompleted + 1,
        failures: [...state.failures, { route: e.route, error: e.error }],
      };
    case "run.completed":
      return { ...state, status: e.ok === 0 ? "failed" : "built", current: null };
    // assemble.done / report.done / page.*.done(capture,project) / edit.* — no RunState change.
    default:
      return state;
  }
}

/** Replay an event log into a RunState (admin: job_logs → RunState). */
export function projectRunState(events: EngineEvent[]): RunState {
  return events.reduce(reduceRunState, initialRunState());
}

// --- Line serialization for the CLI --emit-events bridge ---

/**
 * A control-char marker (U+0001) that will never appear in normal stdout text,
 * so the parent process can pick event lines out of interleaved console output.
 */
export const EVENT_MARKER = "\u0001MILO_EVENT:";

export function eventToJsonLine(e: EngineEvent): string {
  return EVENT_MARKER + JSON.stringify(e);
}

/** Parse one stdout line; returns the event, or null if the line carries no valid event. */
export function parseEventLine(line: string): EngineEvent | null {
  const i = line.indexOf(EVENT_MARKER);
  if (i === -1) return null;
  const json = line.slice(i + EVENT_MARKER.length);
  try {
    return JSON.parse(json) as EngineEvent;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism test/events.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck**

Run: `packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add packages/clone-engine/src/events.ts packages/clone-engine/test/events.test.ts
git commit -m "feat(engine): EngineEvent contract + pure RunState projection + line serializer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Emit page/assemble/report events from `buildSite`

**Files:**
- Modify: `packages/clone-engine/src/orchestrate.ts` (`BuildSiteOpts` ~line 74; `buildSite` body — capture `:151`, project `:222`, build `execSync` `:243`, failure `:311`, assemble `:355`, report `:383`)

- [ ] **Step 1: Add the import + `onEvent` to `BuildSiteOpts`**

At the top of `orchestrate.ts`, after the existing `report` import (line 25), add:

```ts
import type { EngineEventSink } from "./events.ts";
```

In `BuildSiteOpts` (after the `builtAt?` field, ~line 96), add:

```ts
  /**
   * Optional progress sink. When provided, buildSite emits typed EngineEvents at
   * each phase boundary (in addition to the existing console.log). No-op when omitted,
   * so existing callers and the 0-px oracle are unaffected.
   */
  onEvent?: EngineEventSink;
```

- [ ] **Step 2: Add a local emit helper at the top of `buildSite`**

In `buildSite`, right after `const wallStart = Date.now();` (line 109), add:

```ts
  const emit: EngineEventSink = opts.onEvent ?? (() => {});
```

- [ ] **Step 3: Emit around capture**

In the per-page `try` block, wrap the capture. Replace the capture block (lines 145–161, from `const captureDir = ...` through the closing `}` of the `if (!captureCached) { … } else { … }`) so it emits `page.capture.started` before and `page.capture.done` after. Concretely, add `emit({ type: "page.capture.started", route: p.route });` immediately before line 145's `const captureDir = path.join(cwd, p.dir);`, and add `emit({ type: "page.capture.done", route: p.route });` immediately after line 161's closing `}` of the capture if/else (before the "Label pass" comment on line 163).

- [ ] **Step 4: Emit around project**

Immediately before line 222 (`console.log(\`=== PROJECT ${p.route} …`)), add:

```ts
      emit({ type: "page.project.started", route: p.route });
```

Immediately after line 231 (`projectMs = Date.now() - tProject;`), add:

```ts
      emit({ type: "page.project.done", route: p.route });
```

- [ ] **Step 5: Emit around the astro build**

Immediately before line 242 (`const tBuild = Date.now();`), add:

```ts
      emit({ type: "page.build.started", route: p.route });
```

Immediately after line 247 (`buildMs = Date.now() - tBuild;`), add:

```ts
      emit({ type: "page.build.done", route: p.route });
```

- [ ] **Step 6: Emit on page failure**

In the `catch (e)` block, immediately after line 311 (`console.log(\`!!! FAILED ${p.route}: …`)), add:

```ts
      emit({ type: "page.failed", route: p.route, error: msg.split("\n")[0] });
```

- [ ] **Step 7: Emit assemble.done + report.done**

Immediately after line 358–360's assembled `console.log(...)` statement (the `✓ assembled full-site/ …` log), add:

```ts
  emit({ type: "assemble.done", pages: assembled.length, fullSiteDir: fullSite });
```

Then in the `if (opts.reportOut && pageReports.length > 0) {` block, immediately after the `generateHtmlReport(report, opts.reportOut);` call (~line 383), add:

```ts
    emit({
      type: "report.done",
      reportHtmlPath: opts.reportOut,
      reportJsonPath: opts.reportOut.replace(/\.html?$/i, ".json"),
    });
```

- [ ] **Step 8: Typecheck**

Run: `packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine`
Expected: clean. (No new tests — emission is exercised by the acceptance run in Task 5 + Plan 2's integration.)

- [ ] **Step 9: Run the existing orchestrate tests to confirm no regression**

Run: `pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism test/orchestrate-label.test.ts`
Expected: PASS (unchanged — the sink defaults to a no-op).

- [ ] **Step 10: Commit**

```bash
git add packages/clone-engine/src/orchestrate.ts
git commit -m "feat(engine): buildSite emits page/assemble/report EngineEvents via optional onEvent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Emit run/discover events from `buildSiteAuto` (with live-growing discovery)

**Files:**
- Modify: `packages/clone-engine/src/discover.ts` (`DiscoverOpts` ~line 26; sitemap-index loop ~line 228; flat-urlset loop ~line 246; final return ~line 316)
- Modify: `packages/clone-engine/src/orchestrate.ts` (`buildSiteAuto` ~line 416)

- [ ] **Step 1: Add `onProgress` to `DiscoverOpts`**

In `discover.ts`, extend `DiscoverOpts` (line 26):

```ts
export interface DiscoverOpts {
  /** Max UGC pages to return (default 25). Logs a warning when truncating. */
  ugcLimit?: number;
  /**
   * Optional incremental callback fired as pages are found, so a UI can show the
   * discovered count growing (page 4/18 → 4/19). Reports the running core/ugc split
   * and the routes so far. Fired at least once (final) before discoverPages returns.
   */
  onProgress?: (p: { coreFound: number; ugcFound: number; routes: string[] }) => void;
}
```

- [ ] **Step 2: Fire `onProgress` incrementally during discovery**

`discoverPages` collects `allPaths` first and classifies at the end. To fire progress *as it goes* honestly, add a small running classifier. In `discoverPages`, immediately after `let sitemapOk = false;` (line 219) add:

```ts
  const emitProgress = () => {
    if (!opts.onProgress) return;
    const core = new Set<string>(["/"]);
    const ugc = new Set<string>();
    for (const raw of allPaths) {
      const tagged = raw.startsWith(UGC_TAG);
      const p = tagged ? raw.slice(UGC_TAG.length) : raw;
      if (p === "/") continue;
      if (tagged || isUgcPath(p)) ugc.add(p); else core.add(p);
    }
    opts.onProgress({ coreFound: core.size, ugcFound: ugc.size, routes: [...core, ...ugc] });
  };
```

Then, inside the sitemap-index loop, immediately after the inner `for (const loc of locs) { … }` that pushes to `allPaths` (i.e. right after line 239's closing `}` of that inner loop, still inside the `try`), add:

```ts
          emitProgress();
```

And in the flat-urlset branch, immediately after its `for (const loc of locs) { … }` (after line 250's closing `}`), add:

```ts
      emitProgress();
```

Finally, immediately before the `return { core: …, ugc: … };` (line 316), add a last authoritative fire:

```ts
  emitProgress();
```

- [ ] **Step 3: Typecheck discover changes**

Run: `packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine`
Expected: clean.

- [ ] **Step 4: Run existing discover tests (no regression)**

Run: `pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism test/discover.test.ts`
Expected: PASS (unchanged — `onProgress` is optional).

- [ ] **Step 5: Emit run/discover/completed in `buildSiteAuto`**

In `orchestrate.ts` `buildSiteAuto` (line 416+). After `const { mode = "core", ugcLimit, coreReportOut, ugcReportOut, ...buildOpts } = opts;` (line 420), add:

```ts
  const emit = makeEmit(opts.onEvent);
  emit({ type: "run.started", origin });
```

(`makeEmit` is the shared insulated emitter added to `events.ts` in Task 2 — it swallows sink exceptions so a throwing consumer can never corrupt a build. Use it here too rather than a bare `?? (() => {})`.)

Change the `discoverPages(origin, { ugcLimit })` call (line 423) to forward progress as `discover.progress` events:

```ts
  const discovered = await discoverPages(origin, {
    ugcLimit,
    onProgress: (p) => emit({ type: "discover.progress", ...p }),
  });
```

At the very end of `buildSiteAuto`, immediately before its `return { core: coreResult, ugc: ugcResult };` (or whatever the final return is — the function returns a `BuildSiteAutoResult`), add:

```ts
  emit({ type: "run.completed", ok: coreResult.ok.length, failed: coreResult.failed.length });
```

Note: `coreResult` is the variable holding the core pass's `BuildSiteResult` (the function already builds `core` — use its actual local name from the code; if the return is `{ core, ugc }`, use `core.ok.length` / `core.failed.length`). Since `buildOpts` already includes `onEvent` (it's part of `BuildSiteOpts`), the per-page events from `buildSite` flow automatically.

- [ ] **Step 6: Add `EngineEventSink` import if not already present**

Ensure `orchestrate.ts` has (from Task 2): `import { makeEmit, type EngineEventSink } from "./events.ts";` — already added in Task 2, so `makeEmit` is in scope here. No import change needed.

- [ ] **Step 7: Typecheck**

Run: `packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/clone-engine/src/discover.ts packages/clone-engine/src/orchestrate.ts
git commit -m "feat(engine): buildSiteAuto emits run.started/discover.progress/run.completed; live-growing discovery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: CLI `build-auto --emit-events`

**Files:**
- Modify: `packages/clone-engine/src/cli.ts` (`BOOLEAN_FLAGS` line 79; usage line 98; `build-auto` case ~line 186)

- [ ] **Step 1: Register `emit-events` as a boolean flag**

In `cli.ts`, change `BOOLEAN_FLAGS` (line 79) to include the new flag so the subcommand finder doesn't treat the next token as its value:

```ts
const BOOLEAN_FLAGS = new Set(["no-llm", "emit-events"]);
```

- [ ] **Step 2: Import the serializer**

Add to the imports at the top of `cli.ts` (after line 23's `run-mjs` import):

```ts
import { eventToJsonLine, type EngineEventSink } from "./events.ts";
```

- [ ] **Step 3: Attach the sink in the `build-auto` case**

In the `build-auto` case (line 186), after `const ugcLimit = ugcLimitStr ? parseInt(ugcLimitStr, 10) : undefined;` (line 193), add:

```ts
    const emitEvents = hasFlag("emit-events");
    const onEvent: EngineEventSink | undefined = emitEvents
      ? (e) => process.stdout.write(eventToJsonLine(e) + "\n")
      : undefined;
```

Then pass it into the `buildSiteAuto` call (line 195):

```ts
    await buildSiteAuto(site, {
      cwd: buildCwd,
      mode,
      reportOut,
      ugcLimit,
      onEvent,
    });
```

- [ ] **Step 4: Update the usage strings**

Update the usage line 98 and the `default` case's valid-subcommands line 217 to mention `--emit-events` on `build-auto` (append to the `build-auto` comment at line 187):

```ts
    // node src/cli.ts build-auto --site <origin> [--mode core|full] [--out <report.html>] [--cwd <dir>] [--ugc-limit <n>] [--emit-events]
```

- [ ] **Step 5: Typecheck**

Run: `packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/clone-engine/src/cli.ts
git commit -m "feat(engine): CLI build-auto --emit-events streams EngineEvents as JSON lines

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Export + full verification + live smoke

**Files:**
- Modify: `packages/clone-engine/src/index.ts`

- [ ] **Step 1: Re-export the events module**

In `packages/clone-engine/src/index.ts`, after the existing exports (e.g. after line 24's `discover` exports), add:

```ts
// Progress event contract + pure RunState projection + CLI line serializer.
export {
  initialRunState,
  reduceRunState,
  projectRunState,
  makeEmit,
  eventToJsonLine,
  parseEventLine,
  EVENT_MARKER,
} from "./events.ts";
export type { EngineEvent, EngineEventSink, EnginePhase, RunState } from "./events.ts";
```

- [ ] **Step 2: Typecheck the whole package**

Run: `packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine`
Expected: clean.

- [ ] **Step 3: Run the events unit tests + the two regression suites**

Run: `pnpm --filter @milo/clone-engine exec vitest run --no-file-parallelism test/events.test.ts test/discover.test.ts test/orchestrate-label.test.ts`
Expected: PASS across all three (events green; discover + orchestrate-label unchanged).

- [ ] **Step 4: Live smoke — watch real events stream**

This is the acceptance for Plan 1 (per the spec: "watch a real clone run"). Run against a real site with a cached capture if available, else a small real site. Requires env for the LLM labeler.

Run:
```bash
cd packages/clone-engine
node --env-file=/Users/dan/pushpress/milo/.env src/cli.ts build-auto \
  --site https://speakeasyofstrength.com --mode core --emit-events --cwd /tmp/milo-smoke 2>/dev/null \
  | grep -a "$(printf '\001')MILO_EVENT:" | head -30
```
Expected: a stream of JSON-lines events — `run.started`, one or more `discover.progress` (with growing `coreFound`), interleaved `page.capture.started/done`, `page.project.started/done`, `page.build.started/done` per route, `assemble.done`, `run.completed`. Confirm the event shapes match the `EngineEvent` union. (This is a manual eyeball; it exercises the whole emit path end-to-end.)

- [ ] **Step 5: Commit**

```bash
git add packages/clone-engine/src/index.ts
git commit -m "feat(engine): export events module (EngineEvent/RunState/serializer) from package index

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (against the spec)

- **Spec coverage (seam ①):** `EngineEvent` union (clone + edit) — Task 1. `RunState` rollup + pure projection (`job_logs → RunState`) — Task 1. `onEvent` on `BuildSiteOpts`/`BuildSiteAutoOpts` + emission at the console.log seam points — Tasks 2–3. Live-growing discovery (`discover.progress` firing incrementally) — Task 3 (addresses the spec's flagged discovery-incrementality risk). CLI `--emit-events` JSON-lines bridge with a marker (spec: "dedicated marker + stripControl") — Tasks 1 & 4. The marker (`U+0001`) can't appear in normal text, giving robust separation from interleaved stdout.
- **Deferred by design (documented in scope):** `edit.*` events are defined but not emitted — emission lands in Plan 2 with `POST /sites/:id/edits` and the CLI `edit --emit-events` subcommand. No admin/UI code here.
- **Never-regress:** every seam is behind an optional `onEvent`/`onProgress` that defaults to a no-op; Tasks 2/3 re-run the existing `orchestrate-label` + `discover` suites to prove no behavior change. The 0-px projection oracle is untouched (no change to `project.ts`).
- **Placeholder scan:** none — every step has exact file paths, line anchors, and complete code.
- **Type consistency:** `EngineEvent`, `EngineEventSink`, `RunState`, `EnginePhase`, `EVENT_MARKER`, `eventToJsonLine`, `parseEventLine`, `reduceRunState`, `projectRunState`, `initialRunState` are named identically across Tasks 1–5. `discover.progress` payload (`coreFound`/`ugcFound`/`routes`) matches `DiscoverOpts.onProgress`'s shape, so `emit({ type: "discover.progress", ...p })` type-checks.
- **One flagged uncertainty:** the exact local variable name for the core pass's `BuildSiteResult` in `buildSiteAuto` (Task 3, Step 5) — the plan says to use the actual name from the code (`core.ok.length` if the return is `{ core, ugc }`). The executor confirms it by reading the function's final return before editing.
```
