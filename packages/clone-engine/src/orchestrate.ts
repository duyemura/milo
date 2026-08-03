/**
 * Whole-site orchestrator: capture → project(base+links) → astro build → assemble.
 *
 * Ported from page-clone-spike/build-site.mjs. Key changes from the original:
 *   1. Hardcoded origin + PAGES moved into `opts`; the Speakeasy list is kept as
 *      the default in the CLI, not here — callers must supply both.
 *   2. `execSync("node page-clone.mjs …")` and `execSync("node project-page.mjs …")`
 *      replaced by direct calls to the TS `capture()` and `project()` functions.
 *   3. `astro build` and `cp -R` still shell out — those are external tools.
 *
 * All crawl/link-map/per-page/assemble logic is otherwise identical to the spike.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findAstroJs, findAstroModules } from "./astro.ts";
import type { Browser } from "playwright";
import { injectTrackerIntoSite } from "./pagegoal.ts";
import { migrateExistingAssets } from "./assets/migrate.ts";
import { injectSeoFiles } from "./sitemap.ts";
import { injectGtag } from "@milo/measurement";
import { buildReport, renderSiteReport } from "./buildreport/index.ts";
import type { SiteReport } from "./buildreport/types.ts";
import { capture } from "./capture.ts";
import { project } from "./project.ts";
import { label, heuristicLabels } from "./labels.ts";
import type { LabelSource } from "./labels.ts";
import { llmCostAccumulator } from "@milo/llm";
import type { CaptureJson, Labels } from "./types.ts";
import { originSlug, pageDir, discoverPages } from "./discover.ts";
import type { DiscoverOpts } from "./discover.ts";
import { mapPool, autoConcurrency } from "./concurrency.ts";
import type { BuildReport, PageReport, PageIssues } from "./report.ts";
import { generateHtmlReport } from "./report.ts";
import { makeEmit, type EngineEventSink } from "./events.ts";

/** Promise over spawn; rejects on non-zero exit. Keeps the event loop free so
 *  pooled astro builds overlap (execSync would block the single Node thread). */
function run(cmd: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [], { cwd, stdio: "inherit", shell: "/bin/bash" });
    child.on("error", reject);
    child.on("close", (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`command failed (exit ${code}): ${cmd}`)));
  });
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

/** Rates for google/gemini-2.5-flash (mid-2025) via OpenRouter. */
const COST_PER_M_INPUT_USD = 0.10;
const COST_PER_M_OUTPUT_USD = 0.40;

function computeLabelCost(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * COST_PER_M_INPUT_USD +
    (completionTokens / 1_000_000) * COST_PER_M_OUTPUT_USD;
}

interface AccumulatorSnap { promptTokens: number; completionTokens: number; model: string }

/** Flatten the accumulator summary to total tokens + the most-recently-used model. */
function accumulatorTotal(
  summary: Array<{ model: string; promptTokens: number; completionTokens: number; calls: number }>,
): AccumulatorSnap {
  let promptTokens = 0;
  let completionTokens = 0;
  let model = "unknown";
  for (const s of summary) {
    promptTokens += s.promptTokens;
    completionTokens += s.completionTokens;
    model = s.model; // last entry wins (only one model used per label call in practice)
  }
  return { promptTokens, completionTokens, model };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageSpec {
  route: string;
  /** The capture output directory (e.g. "dist-se-full"). */
  dir: string;
}

/** A PageSpec with the two fields the build derives internally: the absolute
 *  source URL and the per-page projection output dir. */
interface AugmentedPage extends PageSpec {
  url: string;
  out: string;
}

export interface BuildSiteOpts {
  origin: string;
  pages: PageSpec[];
  /** Working directory for the build. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * If set, write a build-report.html (and build-report.json) to this path when
   * the build completes. The report includes per-page timings, LLM cost, issues,
   * and fidelity data.
   */
  reportOut?: string;
  /**
   * When true (the default), run the LLM semantic labeler before each projection so
   * `project()` picks up richer brand slots + section/element roles from `labels.json`.
   * Falls back to the heuristic automatically on any LLM error or missing provider env.
   * Set to false to force the deterministic heuristic-only path (no LLM cost incurred).
   */
  llm?: boolean;
  /**
   * Max pages built concurrently. Defaults to autoConcurrency() — sized to the
   * host (cgroup-aware, so it's correct locally and on any Railway instance).
   */
  concurrency?: number;
  /**
   * ISO timestamp for the report's generatedAt field. If omitted, new Date().toISOString()
   * is used. Useful for reproducible report output in tests or CI.
   */
  builtAt?: string;
  /**
   * Optional progress sink. When provided, buildSite emits typed EngineEvents at
   * each phase boundary (in addition to the existing console.log). No-op when omitted,
   * so existing callers and the 0-px oracle are unaffected. Sink exceptions are
   * swallowed, so a throwing consumer can never break the build.
   */
  onEvent?: EngineEventSink;
  /**
   * Playwright browser instance. When provided, buildSite runs the site build report
   * (ship/no-ship gate) after assembly and writes `build-report.html` + `build-report.json`
   * to `full-site/`. Safe: a failing report never breaks the build — issues surface in the report.
   */
  browser?: Browser;
  /**
   * Source capture directory (has capture.json + source-desktop.png). When provided alongside
   * `browser`, enables clone-fidelity checks in the build report (SEO regression, iframe
   * preservation, pixel diff vs source screenshot).
   */
  sourceCaptureDir?: string;
}

export interface BuildSiteResult {
  /** Pages that captured, projected, and built successfully (in `full-site/`). */
  ok: PageSpec[];
  /** Pages that were skipped after a failure (logged, excluded from `full-site/`). */
  failed: PageSpec[];
  /**
   * The site build report produced after assembly (ship/no-ship gate).
   * Always present — `buildSite` launches its own browser if none is supplied via `opts.browser`.
   * The HTML version is written to `full-site/build-report.html`; the JSON to `full-site/build-report.json`.
   */
  siteReport?: SiteReport;
  /** Absolute path to the written `full-site/build-report.html`. */
  reportHtmlPath?: string;
}

/** Result of building one page — collected by the pool and reduced into ok/failed. */
interface PageBuildResult {
  page: AugmentedPage;
  status: "ok" | "failed";
  report?: PageReport;
}

/**
 * Capture → label → project → astro-build one page. This is the former per-page
 * loop body, extracted so it can run over a bounded concurrency pool. It never
 * throws — a per-page failure comes back as status:"failed" so one bad page can't
 * abort the pool. LLM cost is NOT attributed per page here (it can't be computed
 * race-free under concurrency); buildSite reports an accurate run-level aggregate.
 */
async function buildOnePage(ctx: {
  p: AugmentedPage;
  pageIdx: number;
  total: number;
  cwd: string;
  linksFile: string;
  runLlm: boolean;
  collectReport: boolean;
  reportOut?: string;
  emit: ReturnType<typeof makeEmit>;
}): Promise<PageBuildResult> {
  const { p, pageIdx, total, cwd, linksFile, runLlm, collectReport, reportOut, emit } = ctx;
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
      captureMs = Date.now() - t;
      freshCaptureMs = captureMs; // record for future warm-run reports
    } else {
      console.log(`\n=== capture cached ${p.route} ===`);
    }
    emit({ type: "page.capture.done", route: p.route });

    // Label pass: run before project() so it picks up labels.json. LLM is an
    // enhancement; label() falls back to the heuristic on any error.
    let lblsForReport: Labels | null = null;
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
            lblsForReport = result.labels;
            pageLabelSource = result.source;
            pageLabelFallbackReason = result.fallbackReason;
          } else {
            console.log(`=== label cached ${p.route} ===`);
            lblsForReport = JSON.parse(fs.readFileSync(labelsJsonPath, "utf8")) as Labels;
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

    // astro build: the engine owns astro@^4.16. Symlink the engine's node_modules into
    // the per-page project so astro can find astro/config and its peer deps, then run
    // astro.js by absolute path. pnpm's node_modules resolves through the symlink fine.
    const astroDir = path.join(cwd, p.out, "astro");
    const astroJs = findAstroJs();
    const mods = findAstroModules();
    if (!mods) throw new Error("astro node_modules not found — install astro@^4.16 or set ASTRO_MODULES");
    const link = path.join(astroDir, "node_modules");
    if (!fs.existsSync(link)) fs.symlinkSync(mods, link, "dir");
    emit({ type: "page.build.started", route: p.route });
    const tBuild = Date.now();
    await run(`node "${astroJs}" build`, astroDir);
    buildMs = Date.now() - tBuild;
    emit({ type: "page.build.done", route: p.route });

    let report: PageReport | undefined;
    if (collectReport) {
      const unknownSections = lblsForReport ? lblsForReport.sections.filter((s) => s.role === "unknown").length : 0;
      let leftoverSourceRefs = 0;
      let assetCount: number | undefined;
      try {
        const cap = JSON.parse(fs.readFileSync(captureJsonPath, "utf8")) as { sourceOrigins?: string[]; assets?: unknown[] };
        leftoverSourceRefs = cap.sourceOrigins?.length ?? 0;
        if (Array.isArray(cap.assets)) assetCount = cap.assets.length;
      } catch { /* ignore — not critical */ }
      let pageWeightKb: number | undefined;
      try {
        const builtIndex = path.join(cwd, p.out, "astro/dist/index.html");
        if (fs.existsSync(builtIndex)) pageWeightKb = Math.round(fs.statSync(builtIndex).size / 1024);
      } catch { /* ignore */ }
      const thumbAbs = path.join(captureDir, "source-desktop.png");
      const thumbPath = fs.existsSync(thumbAbs) && reportOut ? path.relative(path.dirname(reportOut), thumbAbs) : undefined;
      const issues: PageIssues = {
        assetsFailed: 0,
        leftoverSourceRefs,
        labelSource: pageLabelSource,
        labelFallbackReason: pageLabelFallbackReason,
        unknownSections,
        captureRetries: 0,
        selfContainmentWarnings: 0,
      };
      report = {
        route: p.route,
        status: "ok",
        timing: { route: p.route, captureMs, labelMs, projectMs, buildMs, captureCached, freshCaptureMs },
        llm: undefined, // per-page LLM cost is not attributable under concurrency; see run-level total
        issues,
        thumbPath,
        assetCount,
        pageWeightKb,
      };
    }
    return { page: p, status: "ok", report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`!!! FAILED ${p.route}: ${msg.split("\n")[0]}`);
    emit({ type: "page.failed", route: p.route, error: msg.split("\n")[0] });
    const report: PageReport | undefined = collectReport
      ? {
          route: p.route,
          status: "failed",
          error: msg,
          timing: { route: p.route, captureMs, labelMs, projectMs, buildMs, captureCached: false },
          issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "heuristic-disabled", unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
        }
      : undefined;
    return { page: p, status: "failed", report };
  }
}

export async function buildSite(opts: BuildSiteOpts): Promise<BuildSiteResult> {
  const { origin, pages } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const wallStart = Date.now();
  const emit = makeEmit(opts.onEvent);

  // Augment pages with derived url + out fields (mirrors build-site.mjs PAGES.forEach).
  // out-dir is namespaced by origin slug (2-char prefix) so two different origins built
  // in the same cwd never collide on the same route (e.g. both "/" → "sp-home").
  const slug = originSlug(origin);
  const augmented: AugmentedPage[] = pages.map((p) => ({
    ...p,
    url: origin + p.route,
    out: pageDir(slug, p.route),
  }));

  // Full internal link map (both slash forms) so nav rewrites everywhere.
  const links: Record<string, string> = {};
  for (const p of augmented) {
    links[p.url] = p.route;
    links[p.url.replace(/\/$/, "")] = p.route;
  }
  const linksFile = path.join(cwd, "links-site.json");
  fs.writeFileSync(linksFile, JSON.stringify(links, null, 1));

  const collectReport = Boolean(opts.reportOut);
  const runLlm = opts.llm !== false; // default true
  const concurrency = opts.concurrency ?? autoConcurrency();
  console.log(`[build] concurrency=${concurrency} over ${augmented.length} page(s)`);

  // Build every page over a bounded pool sized to the host. buildOnePage never
  // throws — failures come back as status:"failed" — so one bad page can't abort
  // the pool. Results are reduced into ok/failed/pageReports after the barrier.
  const results = await mapPool(augmented, concurrency, (p, pageIdx) =>
    buildOnePage({ p, pageIdx, total: augmented.length, cwd, linksFile, runLlm, collectReport, reportOut: opts.reportOut, emit }));

  const ok: AugmentedPage[] = [];
  const failed: AugmentedPage[] = [];
  const pageReports: PageReport[] = [];
  for (const r of results) {
    (r.status === "ok" ? ok : failed).push(r.page);
    if (r.report) pageReports.push(r.report);
  }

  // Every page failed → don't silently emit an empty full-site/; surface a hard error
  // so the CLI exits non-zero (programmatic callers get the throw too).
  if (ok.length === 0) {
    throw new Error(`buildSite: all ${augmented.length} page(s) failed — no site to assemble`);
  }

  // Assemble full-site/ from all successful page builds.
  const fullSite = path.join(cwd, "full-site");
  fs.rmSync(fullSite, { recursive: true, force: true });
  fs.mkdirSync(fullSite);

  const assembled: AugmentedPage[] = [];
  for (const p of ok) {
    const astroDist = path.join(cwd, p.out, "astro/dist");
    if (!fs.existsSync(astroDist)) {
      // Astro build reported success but left no dist/ — skip to avoid crashing assembly.
      console.warn(`[assemble] warning: ${p.route} has no dist/ — skipping from full-site`);
      continue;
    }
    const dest =
      p.route === "/"
        ? fullSite
        : path.join(fullSite, p.route.replace(/^\/|\/$/g, ""));
    // Defense-in-depth: routes should be de-duped upstream (discover collapses index.html →
    // dir), but if two routes still map to the same slot, never let a mkdir-over-a-file crash
    // the whole assembly after a long build — skip the later duplicate.
    if (dest !== fullSite && fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) {
      console.warn(`[assemble] warning: ${p.route} collides with an already-assembled page — skipping`);
      continue;
    }
    fs.mkdirSync(dest, { recursive: true });
    // Copy the built astro dist contents into the assembled site dir (no shell — Node 24 fs.cpSync).
    fs.cpSync(astroDist, dest, { recursive: true });
    assembled.push(p);
  }

  // Generate sitemap.xml + robots.txt for SEO indexing.
  const assembledRoutes = assembled.map((p) => p.route);
  injectSeoFiles(fullSite, origin, assembledRoutes);

  // Inject GA4 gtag config + engagement tracker into every assembled HTML page (Subsystem F).
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  if (measurementId) {
    // Walk every .html file and inject the gtag initialization before </head>.
    const walkHtml = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walkHtml(abs); continue; }
        if (!entry.name.endsWith(".html")) continue;
        const html = fs.readFileSync(abs, "utf8");
        const { html: injected, changed } = injectGtag(html, measurementId);
        if (changed) fs.writeFileSync(abs, injected);
      }
    };
    walkHtml(fullSite);
  }
  injectTrackerIntoSite(fullSite);

  // Auto-migrate: on first build for a site that has no library yet, catalog its captured
  // assets so the planner and composePage can reference them. Idempotent — subsequent builds
  // are a no-op. Tags are NOT run automatically (no CV cost on build) — assets land pending.
  const libraryPath = path.join(fullSite, "library.json");
  if (!fs.existsSync(libraryPath) && ok.length > 0) {
    const firstOkDir = path.join(cwd, ok[0].dir);
    const siteRef = { dir: fullSite };
    migrateExistingAssets(fullSite, siteRef).catch((err) => {
      console.warn(`[asset-library] migration warning: ${(err as Error).message}`);
    });
  }

  // Site build report — ship/no-ship gate. Always runs; launches its own browser if not supplied.
  let siteReport: SiteReport | undefined;
  let reportHtmlPath: string | undefined;
  {
    const { chromium } = await import("playwright");
    const ownBrowser = opts.browser ?? await chromium.launch();
    try {
      siteReport = await buildReport({
        siteDir: fullSite,
        browser: ownBrowser,
        source: opts.sourceCaptureDir ? { captureDir: opts.sourceCaptureDir } : undefined,
      });
      const siteReportHtml = renderSiteReport(siteReport);
      reportHtmlPath = path.join(fullSite, "build-report.html");
      const reportJsonPath = path.join(fullSite, "build-report.json");
      fs.writeFileSync(reportHtmlPath, siteReportHtml);
      fs.writeFileSync(reportJsonPath, JSON.stringify(siteReport, null, 2) + "\n");
      console.log(`\nBuild report: ${siteReport.verdict} (${siteReport.blockerCount} blockers) → ${reportHtmlPath}`);
      emit({ type: "report.done" as never, reportHtmlPath, reportJsonPath });
    } catch (err) {
      console.warn(`[build-report] warning: report generation failed: ${(err as Error).message}`);
    } finally {
      if (!opts.browser) await ownBrowser.close(); // only close a browser we launched
    }
  }

  const totalWallMs = Date.now() - wallStart;
  console.log(
    `\n✓ assembled full-site/ with ${assembled.length}/${augmented.length} pages (${ok.length} built ok): ${assembled.map((p) => p.route).join("  ")}`,
  );
  emit({ type: "assemble.done", pages: assembled.length, fullSiteDir: fullSite });

  if (opts.reportOut && pageReports.length > 0) {
    // Infer site name from the first successful page's labels.json if available.
    let siteName = origin;
    try {
      const firstOk = ok[0];
      if (firstOk) {
        const lblsPath = path.join(cwd, firstOk.dir, "labels.json");
        if (fs.existsSync(lblsPath)) {
          const lbls = JSON.parse(fs.readFileSync(lblsPath, "utf8")) as { site?: { name?: string } };
          siteName = lbls.site?.name ?? origin;
        }
      }
    } catch { /* ignore */ }

    // Run-level LLM cost from the global accumulator (accurate regardless of
    // concurrency, unlike the old per-page delta which raced under the pool).
    const snap = accumulatorTotal(llmCostAccumulator.summary());
    const totalLlmTokens = snap.promptTokens || snap.completionTokens
      ? { prompt: snap.promptTokens, completion: snap.completionTokens }
      : undefined;
    const totalLlmCostUsd = totalLlmTokens ? computeLabelCost(snap.promptTokens, snap.completionTokens) : undefined;

    const generatedAt = opts.builtAt ?? new Date().toISOString();
    const report: BuildReport = {
      site: siteName,
      origin,
      generatedAt,
      buildId: `${originSlug(origin)}-${new Date(generatedAt).getTime()}`,
      totalWallMs,
      pages: pageReports,
      totalLlmCostUsd,
      totalLlmTokens,
    };
    generateHtmlReport(report, opts.reportOut);
    // reportJsonPath mirrors generateHtmlReport's convention (foo.html → foo.json).
    emit({
      type: "report.done",
      reportHtmlPath: opts.reportOut,
      reportJsonPath: opts.reportOut.replace(/\.html?$/i, ".json"),
    });
  }

  return { ok, failed, siteReport, reportHtmlPath };
}

// ---------------------------------------------------------------------------
// Auto build: discover → core first → UGC second pass
// ---------------------------------------------------------------------------

export interface BuildSiteAutoOpts extends Omit<BuildSiteOpts, "pages" | "origin">, DiscoverOpts {
  /** 'core' builds only core pages (default). 'full' also runs a second UGC pass. */
  mode?: "core" | "full";
  /** Report output path for the core pass (alias for reportOut on the core build). */
  coreReportOut?: string;
  /** Report output path for the UGC pass (only used when mode==='full'). */
  ugcReportOut?: string;
}

export interface BuildSiteAutoResult {
  /** Result of the core-page build pass. */
  core: BuildSiteResult;
  /** Result of the UGC build pass — present only when mode==='full' and UGC pages exist. */
  ugc?: BuildSiteResult;
}

/**
 * Auto-discover pages via sitemap (or homepage fallback) and build in staged passes:
 *   1. Core pages — always; produces a coherent, publishable site.
 *   2. UGC pages — only when mode==='full'; blog/news follow-up pass.
 *
 * `buildSite()` is unchanged; this orchestrates on top of it.
 */
export async function buildSiteAuto(
  origin: string,
  opts: BuildSiteAutoOpts = {},
): Promise<BuildSiteAutoResult> {
  // onProgress is destructured out (buildSiteAuto builds its own for discoverPages);
  // this keeps it from leaking into buildOpts → the inner buildSite() calls.
  const { mode = "core", ugcLimit, coreReportOut, ugcReportOut, onProgress: _onProgress, ...buildOpts } = opts;
  const emit = makeEmit(opts.onEvent);
  emit({ type: "run.started", origin });

  console.log(`[build-auto] Discovering pages for ${origin}...`);
  const discovered = await discoverPages(origin, {
    ugcLimit,
    onProgress: (p) => emit({ type: "discover.progress", ...p }),
  });
  console.log(
    `[build-auto] Found ${discovered.core.length} core pages, ${discovered.ugc.length} UGC pages`,
  );
  console.log(`[build-auto] Core: ${discovered.core.map((p) => p.route).join("  ")}`);
  if (discovered.ugc.length > 0) {
    const preview = discovered.ugc.slice(0, 5).map((p) => p.route).join("  ");
    const more = discovered.ugc.length > 5 ? " …" : "";
    console.log(`[build-auto] UGC (${discovered.ugc.length}): ${preview}${more}`);
  }

  // --- Core pass ---
  console.log(`\n[build-auto] === CORE PASS (${discovered.core.length} pages) ===`);
  const coreResult = await buildSite({
    ...buildOpts,
    origin,
    pages: discovered.core,
    reportOut: coreReportOut ?? opts.reportOut,
  });

  // --- UGC pass (only when mode==='full') ---
  let ugcResult: BuildSiteResult | undefined;
  if (mode === "full" && discovered.ugc.length > 0) {
    console.log(`\n[build-auto] === UGC PASS (${discovered.ugc.length} pages) ===`);
    ugcResult = await buildSite({
      ...buildOpts,
      origin,
      pages: discovered.ugc,
      reportOut: ugcReportOut,
    });
  } else if (mode === "full" && discovered.ugc.length === 0) {
    console.log(`[build-auto] No UGC pages found — skipping UGC pass`);
  }

  emit({
    type: "run.completed",
    ok: coreResult.ok.length + (ugcResult?.ok.length ?? 0),
    failed: coreResult.failed.length + (ugcResult?.failed.length ?? 0),
  });

  return { core: coreResult, ugc: ugcResult };
}
