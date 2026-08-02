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
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { capture } from "./capture.ts";
import { project } from "./project.ts";
import { label, heuristicLabels } from "./labels.ts";
import { llmCostAccumulator } from "@milo/llm";
import type { CaptureJson } from "./types.ts";
import type { BuildReport, PageReport, PageIssues, PageLlmUsage } from "./report.ts";
import { generateHtmlReport } from "./report.ts";

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
   * If set, write a build-report.html to this path when the build completes.
   * The report includes per-page timings, LLM cost, issues, and fidelity data.
   */
  reportOut?: string;
  /**
   * When true (the default), run the LLM semantic labeler before each projection so
   * `project()` picks up richer brand slots + section/element roles from `labels.json`.
   * Falls back to the heuristic automatically on any LLM error or missing provider env.
   * Set to false to force the deterministic heuristic-only path (no LLM cost incurred).
   */
  llm?: boolean;
}

export interface BuildSiteResult {
  /** Pages that captured, projected, and built successfully (in `full-site/`). */
  ok: PageSpec[];
  /** Pages that were skipped after a failure (logged, excluded from `full-site/`). */
  failed: PageSpec[];
}

export async function buildSite(opts: BuildSiteOpts): Promise<BuildSiteResult> {
  const { origin, pages } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const wallStart = Date.now();

  // Augment pages with derived url + out fields (mirrors build-site.mjs PAGES.forEach).
  const augmented: AugmentedPage[] = pages.map((p) => ({
    ...p,
    url: origin + p.route,
    out: p.route === "/" ? "sp-home" : "sp-" + p.route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""),
  }));

  // Full internal link map (both slash forms) so nav rewrites everywhere.
  const links: Record<string, string> = {};
  for (const p of augmented) {
    links[p.url] = p.route;
    links[p.url.replace(/\/$/, "")] = p.route;
  }
  const linksFile = path.join(cwd, "links-site.json");
  fs.writeFileSync(linksFile, JSON.stringify(links, null, 1));

  const ok: AugmentedPage[] = [];
  const failed: AugmentedPage[] = [];

  // Collect per-page report data (only if reportOut is set).
  const pageReports: PageReport[] = [];
  const collectReport = Boolean(opts.reportOut);

  for (const p of augmented) {
    const t0 = Date.now();
    let captureMs = 0;
    let labelMs = 0;
    let projectMs = 0;
    let buildMs = 0;

    try {
      const captureDir = path.join(cwd, p.dir);
      const captureJsonPath = path.join(captureDir, "capture.json");
      const captureCached = fs.existsSync(captureJsonPath);

      if (!captureCached) {
        console.log(`\n=== CAPTURE ${p.route} ===`);
        const t = Date.now();
        await capture({ url: p.url, out: captureDir, verify: false });
        captureMs = Date.now() - t;
      } else {
        console.log(`\n=== capture cached ${p.route} ===`);
        // Cached: attribute 0ms to capture timing (it ran in a previous session).
        captureMs = 0;
      }

      // Label pass: run before project() so it picks up labels.json.
      // When llm is on, call label({llm:true}) — it writes labels.json and uses the LLM
      // if a provider is configured (falls back to heuristic on any error).
      // When llm is off, use the heuristic-only path and don't write labels.json here
      // (project() will fall back to its own heuristic if no labels.json exists).
      const runLlm = opts.llm !== false; // default true
      let lblsForReport = null;
      let pageLlmUsage: PageLlmUsage | undefined = undefined;
      {
        const tLabel = Date.now();
        try {
          const captureJson = JSON.parse(fs.readFileSync(captureJsonPath, "utf8")) as CaptureJson;
          const labelsJsonPath = path.join(captureDir, "labels.json");

          if (runLlm) {
            // Snapshot accumulator totals before the label call so we can compute delta.
            const preSnap = accumulatorTotal(llmCostAccumulator.summary());

            let usedLlm = false;
            if (!fs.existsSync(labelsJsonPath)) {
              // Not cached — run the label pass (LLM or heuristic fallback).
              // label()'s `out` is a directory (it writes `labels.json` inside it).
              lblsForReport = await label({ dir: captureDir, out: captureDir, llm: true });
              usedLlm = true;
            } else {
              // labels.json already present from a prior run — reuse it (don't re-pay LLM).
              console.log(`=== label cached ${p.route} ===`);
              lblsForReport = JSON.parse(fs.readFileSync(labelsJsonPath, "utf8")) as typeof lblsForReport;
            }

            if (usedLlm) {
              // Compute per-page token delta from the global accumulator.
              const postSnap = accumulatorTotal(llmCostAccumulator.summary());
              const deltaPrompt = postSnap.promptTokens - preSnap.promptTokens;
              const deltaCompletion = postSnap.completionTokens - preSnap.completionTokens;
              if (deltaPrompt > 0 || deltaCompletion > 0) {
                // Pull model name from the accumulator (new entry since preSnap).
                const model = postSnap.model ?? "unknown";
                const costUsd = computeLabelCost(deltaPrompt, deltaCompletion);
                pageLlmUsage = { model, promptTokens: deltaPrompt, completionTokens: deltaCompletion, costUsd };
              }
            }
          } else {
            // llm:false — heuristic only (no labels.json written).
            lblsForReport = heuristicLabels(captureJson);
          }
        } catch { /* ignore — not critical for the build */ }
        labelMs = Date.now() - tLabel;
      }

      const base = p.route === "/" ? "" : p.route.replace(/\/$/, "");
      console.log(`=== PROJECT ${p.route} (base='${base}') ===`);
      const tProject = Date.now();
      await project({
        dir: captureDir,
        out: path.join(cwd, p.out),
        base,
        links: linksFile,
        noDiff: true,
      });
      projectMs = Date.now() - tProject;

      // astro build shells out — it is an external tool, not a TS function.
      // node_modules comes from the spike's out-project-page/astro tree (the canonical
      // Astro install for the clone engine). We use an absolute path so this works
      // from any cwd (not just page-clone-spike/).
      const astroDir = path.join(cwd, p.out, "astro");
      const astroNodeModules = path.resolve(
        import.meta.dirname,
        "../../../page-clone-spike/out-project-page/astro/node_modules",
      );
      const tBuild = Date.now();
      execSync(
        `ln -sf "${astroNodeModules}" node_modules && ./node_modules/.bin/astro build`,
        { cwd: astroDir, stdio: "inherit", shell: "/bin/bash" },
      );
      buildMs = Date.now() - tBuild;

      ok.push(p);

      if (collectReport) {
        // Count issues from available data.
        const unknownSections = lblsForReport
          ? lblsForReport.sections.filter((s) => s.role === "unknown").length
          : 0;
        // llmFallback is true when llm was requested but no LLM cost was incurred
        // (meaning the heuristic ran instead, either because no provider is configured
        // or because a cached labels.json was reused or an error occurred).
        const llmFallback = runLlm && pageLlmUsage === undefined;

        // leftoverSourceRefs: proxy from sourceOrigins length in capture.json.
        let leftoverSourceRefs = 0;
        try {
          const cap = JSON.parse(fs.readFileSync(captureJsonPath, "utf8")) as { sourceOrigins?: string[] };
          leftoverSourceRefs = cap.sourceOrigins?.length ?? 0;
        } catch {
          // ignore — not critical
        }

        const issues: PageIssues = {
          assetsFailed: 0, // not surfaced by capture without refactoring
          leftoverSourceRefs,
          llmFallback,
          unknownSections,
          captureRetries: 0,
          selfContainmentWarnings: 0,
        };

        // Thumbnail: use source-desktop.png from the capture dir.
        const thumbAbs = path.join(captureDir, "source-desktop.png");
        const thumbPath = fs.existsSync(thumbAbs)
          ? path.relative(path.dirname(opts.reportOut!), thumbAbs)
          : undefined;

        pageReports.push({
          route: p.route,
          status: "ok",
          timing: { route: p.route, captureMs, labelMs, projectMs, buildMs },
          llm: pageLlmUsage,
          issues,
          thumbPath,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`!!! FAILED ${p.route}: ${msg.split("\n")[0]}`);
      failed.push(p);

      if (collectReport) {
        pageReports.push({
          route: p.route,
          status: "failed",
          error: msg,
          timing: { route: p.route, captureMs, labelMs, projectMs, buildMs },
          issues: { assetsFailed: 0, leftoverSourceRefs: 0, llmFallback: false, unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
        });
      }
    }

    void t0; // suppress "declared but never read" — used implicitly through captureMs etc.
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
    fs.mkdirSync(dest, { recursive: true });
    // Copy the built astro dist contents into the assembled site dir (no shell — Node 24 fs.cpSync).
    fs.cpSync(astroDist, dest, { recursive: true });
    assembled.push(p);
  }

  const totalWallMs = Date.now() - wallStart;
  console.log(
    `\n✓ assembled full-site/ with ${assembled.length}/${augmented.length} pages (${ok.length} built ok): ${assembled.map((p) => p.route).join("  ")}`,
  );

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

    const report: BuildReport = {
      site: siteName,
      origin,
      generatedAt: new Date().toISOString(),
      totalWallMs,
      pages: pageReports,
    };
    generateHtmlReport(report, opts.reportOut);
  }

  return { ok, failed };
}
