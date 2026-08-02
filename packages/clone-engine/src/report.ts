/**
 * report.ts — build report types and HTML report generator.
 *
 * Collects per-page timing, LLM cost, and issue data from a buildSite() run
 * and produces a self-contained HTML report with summary, page table, cost
 * breakdown, issues, and fidelity spotlight.
 *
 * Admin dashboard consumer: build-report.json is the data contract for the
 * admin UI. It contains structured per-page timing, cost, fidelity, and asset
 * data. The JSON is written alongside the HTML whenever reportOut is set.
 */
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Estimated fresh-capture time per page when no recorded freshCaptureMs exists.
 *  Fresh capture = browser render + all asset rehosting over the network. ~193s observed. */
export const EST_FRESH_CAPTURE_MS_PER_PAGE = 193_000;

export interface PageTiming {
  route: string;
  captureMs: number;
  labelMs: number;
  projectMs: number;
  buildMs: number;
  /** Whether capture was served from cache (capture.json already existed). */
  captureCached: boolean;
  /**
   * Recorded fresh-capture time from a prior run (ms), if available.
   * When captureCached=true and this is set, it's the real cost of the first capture.
   * When captureCached=true and this is absent, use EST_FRESH_CAPTURE_MS_PER_PAGE.
   */
  freshCaptureMs?: number;
}

export interface PageLlmUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface PageIssues {
  /** Assets that failed to rehost (not surfaced by capture without refactoring; reported as 0). */
  assetsFailed: number;
  /** Leftover source-origin refs after rehosting (proxy: sourceOrigins count from capture.json). */
  leftoverSourceRefs: number;
  /**
   * Honest label source:
   *   - "llm-fresh"          LLM ran and succeeded (cost incurred)
   *   - "llm-cached"         labels.json reused from a prior run (no re-cost)
   *   - "heuristic-disabled" llm:false was passed — intentional no-LLM run (benign)
   *   - "heuristic-error"    LLM was attempted but threw (actionable — check key/provider)
   *
   * Replaces the old boolean `llmFallback`, which conflated cached, disabled, and error states.
   */
  labelSource: "llm-fresh" | "llm-cached" | "heuristic-disabled" | "heuristic-error";
  /** When labelSource="heuristic-error": the error message from the failed LLM call. */
  labelFallbackReason?: string;
  /** Number of sections with role="unknown" in the labels. */
  unknownSections: number;
  /** Capture retries (capture doesn't retry at the page level; always 0). */
  captureRetries: number;
  /** Non-fatal self-containment warnings (0 if capture succeeded without throw). */
  selfContainmentWarnings: number;
}

export interface PageReport {
  route: string;
  status: "ok" | "failed";
  error?: string;
  timing: PageTiming;
  llm?: PageLlmUsage;
  issues: PageIssues;
  /** Relative path to the source-desktop screenshot (e.g. "cap-home/source-desktop.png"). */
  thumbPath?: string;
  /**
   * Relative path to the clone screenshot for before/after comparison.
   * Set when a post-build screenshot of the clone is available.
   */
  cloneThumbPath?: string;
  /** Pixel diff from the 0-px oracle (if available). */
  oraclePx?: number;
  /** Number of assets rehosted during capture (for cost-driver context). */
  assetCount?: number;
  /** Size of the built page output in KB (for cost-driver context). */
  pageWeightKb?: number;
}

export interface BuildReport {
  site: string;
  origin: string;
  /** ISO timestamp when the report was generated (from opts.builtAt or new Date().toISOString()). */
  generatedAt: string;
  totalWallMs: number;
  pages: PageReport[];
}

// ---------------------------------------------------------------------------
// HTML report generator
// ---------------------------------------------------------------------------

/** OpenRouter rates for google/gemini-2.5-flash (mid-2025). */
const COST_PER_M_INPUT_USD = 0.10;
const COST_PER_M_OUTPUT_USD = 0.40;

function computeCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * COST_PER_M_INPUT_USD +
    (completionTokens / 1_000_000) * COST_PER_M_OUTPUT_USD;
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.001) return `<$0.001`;
  return `$${usd.toFixed(4)}`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Load image as a base64 data URI, or return null if not found. */
function imageDataUri(imgPath: string, baseDir: string): string | null {
  const resolved = path.isAbsolute(imgPath) ? imgPath : path.join(baseDir, imgPath);
  if (!fs.existsSync(resolved)) return null;
  const buf = fs.readFileSync(resolved);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Compute the "cold-build" capture time for a page.
 * If the capture was cached, use freshCaptureMs if recorded, else the estimate.
 * Returns { ms, estimated: boolean }.
 */
function coldCaptureMs(t: PageTiming): { ms: number; estimated: boolean } {
  if (!t.captureCached) return { ms: t.captureMs, estimated: false };
  if (t.freshCaptureMs != null) return { ms: t.freshCaptureMs, estimated: false };
  return { ms: EST_FRESH_CAPTURE_MS_PER_PAGE, estimated: true };
}

export function generateHtmlReport(report: BuildReport, outPath: string): void {
  const outDir = path.dirname(outPath);

  const okPages = report.pages.filter((p) => p.status === "ok");
  const failedPages = report.pages.filter((p) => p.status === "failed");

  // Aggregate LLM cost
  const totalLlmCostUsd = report.pages.reduce((sum, p) => sum + (p.llm?.costUsd ?? 0), 0);
  const modelSet = new Set(report.pages.filter((p) => p.llm).map((p) => p.llm!.model));
  const modelsStr = modelSet.size === 0 ? "heuristic only" : [...modelSet].join(", ");

  // Cost breakdown by model
  const costByModel = new Map<string, { promptTokens: number; completionTokens: number; costUsd: number; calls: number }>();
  for (const p of report.pages) {
    if (!p.llm) continue;
    const existing = costByModel.get(p.llm.model) ?? { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0 };
    existing.promptTokens += p.llm.promptTokens;
    existing.completionTokens += p.llm.completionTokens;
    existing.costUsd += p.llm.costUsd;
    existing.calls += 1;
    costByModel.set(p.llm.model, existing);
  }

  // Cold-build cost analysis
  let coldCaptureTotal = 0;
  let coldCaptureHasEstimate = false;
  let thisRunWallMs = 0;
  for (const p of report.pages) {
    if (p.status !== "ok") continue;
    const cc = coldCaptureMs(p.timing);
    coldCaptureTotal += cc.ms;
    if (cc.estimated) coldCaptureHasEstimate = true;
    thisRunWallMs += p.timing.captureMs + p.timing.labelMs + p.timing.projectMs + p.timing.buildMs;
  }
  const coldLabelTotal = okPages.reduce((s, p) => s + p.timing.labelMs, 0);
  const coldProjectTotal = okPages.reduce((s, p) => s + p.timing.projectMs, 0);
  const coldBuildTotal = okPages.reduce((s, p) => s + p.timing.buildMs, 0);
  const coldTotalMs = coldCaptureTotal + coldLabelTotal + coldProjectTotal + coldBuildTotal;
  const captureIssuedAnyCached = okPages.some((p) => p.timing.captureCached);

  // Fidelity spotlight: find the homepage page report
  const homePage = report.pages.find((p) => p.route === "/") ?? okPages[0];

  // Thumbnail images (inline base64)
  function thumb(p: PageReport): string {
    if (!p.thumbPath) return "<span style='color:#999'>no thumb</span>";
    const uri = imageDataUri(p.thumbPath, outDir);
    if (!uri) return `<span style='color:#999'>missing: ${escHtml(p.thumbPath)}</span>`;
    return `<img src="${uri}" style="max-width:200px;max-height:150px;object-fit:cover;border:1px solid #ddd;border-radius:4px;" alt="${escHtml(p.route)} screenshot">`;
  }

  // Fidelity spotlight: before/after comparison with slider
  let fidelitySpotlight = "";
  if (homePage) {
    const srcUri = homePage.thumbPath ? imageDataUri(homePage.thumbPath, outDir) : null;
    const cloneUri = homePage.cloneThumbPath ? imageDataUri(homePage.cloneThumbPath, outDir) : null;
    const oracleLine = homePage.oraclePx != null
      ? `<p style="margin-top:8px;font-weight:600;color:${homePage.oraclePx === 0 ? "#22863a" : "#e36209"}">Oracle diff: ${homePage.oraclePx} px${homePage.oraclePx === 0 ? " — perfect fidelity" : ""}</p>`
      : `<p style="margin-top:8px;color:#999">Oracle diff: not measured</p>`;

    if (srcUri && cloneUri) {
      // Before/after slider — pure inline CSS+JS, no external deps
      fidelitySpotlight = `
        <p style="margin-bottom:12px;color:#555;font-size:0.9em">Drag the slider to compare source vs clone. ${homePage.oraclePx != null ? `Pixel diff: <strong>${homePage.oraclePx === 0 ? "0 px — perfect fidelity ✓" : `${homePage.oraclePx} px`}</strong>` : "Oracle diff not measured."}</p>
        <div id="ba-slider" style="position:relative;display:inline-block;max-width:100%;overflow:hidden;border-radius:6px;border:2px solid #d0d0d0;cursor:col-resize;user-select:none">
          <img id="ba-src" src="${srcUri}" style="display:block;max-width:600px;width:100%" alt="Source">
          <div id="ba-clone-wrap" style="position:absolute;top:0;left:0;width:50%;overflow:hidden">
            <img src="${cloneUri}" style="display:block;max-width:600px;width:100%;max-width:600px" alt="Clone">
          </div>
          <div id="ba-divider" style="position:absolute;top:0;left:50%;width:2px;background:#fff;height:100%;transform:translateX(-50%);box-shadow:0 0 4px rgba(0,0,0,0.4)"></div>
          <div id="ba-handle" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-size:14px">⇔</div>
          <div style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.55);color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;pointer-events:none">Source</div>
          <div id="ba-clone-label" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.55);color:#fff;font-size:11px;padding:2px 6px;border-radius:3px;pointer-events:none">Clone</div>
        </div>
        <script>
        (function(){
          var slider = document.getElementById('ba-slider');
          var wrap = document.getElementById('ba-clone-wrap');
          var divider = document.getElementById('ba-divider');
          var handle = document.getElementById('ba-handle');
          var dragging = false;
          function setPos(x) {
            var rect = slider.getBoundingClientRect();
            var pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
            var pcStr = (pct * 100).toFixed(2) + '%';
            wrap.style.width = pcStr;
            divider.style.left = pcStr;
            handle.style.left = pcStr;
          }
          slider.addEventListener('mousedown', function(e){ dragging = true; setPos(e.clientX); e.preventDefault(); });
          slider.addEventListener('touchstart', function(e){ dragging = true; setPos(e.touches[0].clientX); }, {passive:true});
          document.addEventListener('mousemove', function(e){ if(dragging) setPos(e.clientX); });
          document.addEventListener('touchmove', function(e){ if(dragging) setPos(e.touches[0].clientX); }, {passive:true});
          document.addEventListener('mouseup', function(){ dragging = false; });
          document.addEventListener('touchend', function(){ dragging = false; });
        })();
        </script>
        ${oracleLine}`;
    } else if (srcUri) {
      // Only source available — show it with a note asking for clone screenshot
      fidelitySpotlight = `
        <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;">
          <div>
            <p style="margin:0 0 6px;font-weight:600;color:#555;">Source (captured)</p>
            <img src="${srcUri}" style="max-width:500px;border:2px solid #d0d0d0;border-radius:6px;" alt="Source screenshot">
            <p style="margin-top:6px;color:#888;font-size:0.85em;">Clone screenshot not available — add cloneThumbPath to PageReport for before/after comparison.</p>
          </div>
        </div>
        ${oracleLine}`;
    }
  }

  // Build the page rows
  const pageRows = report.pages.map((p) => {
    const status = p.status === "ok"
      ? `<span style="color:#22863a;font-weight:600;">ok</span>`
      : `<span style="color:#cb2431;font-weight:600;">failed</span>`;

    // Capture cell: annotate cached entries honestly
    let captureCell = "";
    if (p.status === "ok") {
      if (p.timing.captureCached) {
        const cc = coldCaptureMs(p.timing);
        const est = cc.estimated ? " (estimated)" : "";
        captureCell = `<td style="white-space:nowrap;color:#888" title="Served from cache. Fresh capture cost: ${formatMs(cc.ms)}${est}">cached (fresh≈${formatMs(cc.ms)}${est})</td>`;
      } else {
        captureCell = `<td style="white-space:nowrap">${formatMs(p.timing.captureMs)}</td>`;
      }
    } else {
      captureCell = `<td style="color:#999">—</td>`;
    }

    const timing = p.status === "ok" ? `
      ${captureCell}
      <td style="white-space:nowrap">${formatMs(p.timing.labelMs)}</td>
      <td style="white-space:nowrap">${formatMs(p.timing.projectMs)}</td>
      <td style="white-space:nowrap">${formatMs(p.timing.buildMs)}</td>
    ` : `${captureCell}<td colspan="3" style="color:#999">—</td>`;

    // LLM cell: honest messaging per label source
    let llm = "";
    if (p.llm) {
      llm = `
        <td>${formatTokens(p.llm.promptTokens)}</td>
        <td>${formatTokens(p.llm.completionTokens)}</td>
        <td>${formatCost(p.llm.costUsd)}</td>
      `;
    } else if (p.issues.labelSource === "llm-cached") {
      llm = `<td colspan="3" style="color:#888" title="Labels reused from prior run — cost was paid on first build, not this run">cached (paid on first build)</td>`;
    } else {
      llm = `<td colspan="3" style="color:#999">heuristic</td>`;
    }

    const oracle = p.oraclePx != null ? `${p.oraclePx}px` : "—";

    const issues: string[] = [];
    const errorIssues: string[] = [];
    if (p.issues.assetsFailed > 0) issues.push(`${p.issues.assetsFailed} assets failed`);
    if (p.issues.leftoverSourceRefs > 0) issues.push(`${p.issues.leftoverSourceRefs} source refs`);
    if (p.issues.labelSource === "heuristic-error") {
      const reason = p.issues.labelFallbackReason ? ` (${p.issues.labelFallbackReason})` : "";
      errorIssues.push(`LLM labeling failed${reason} — check OPENROUTER_API_KEY / provider config`);
    } else if (p.issues.labelSource === "llm-cached") {
      issues.push("labels cached");
    }
    if (p.issues.unknownSections > 0) issues.push(`${p.issues.unknownSections} unknown sections`);
    const issueCell = errorIssues.length > 0
      ? `<span style="color:#cb2431;font-weight:600">${escHtml(errorIssues.join("; "))}</span>`
        + (issues.length > 0 ? `<br><span style="color:#e36209">${escHtml(issues.join(", "))}</span>` : "")
      : issues.length > 0
        ? `<span style="color:#e36209">${escHtml(issues.join(", "))}</span>`
        : `<span style="color:#22863a">clean</span>`;

    const errorNote = p.error ? `<br><small style="color:#cb2431">${escHtml(p.error.slice(0, 120))}</small>` : "";

    return `<tr>
      <td style="white-space:nowrap"><code>${escHtml(p.route)}</code>${errorNote}</td>
      <td>${status}</td>
      ${timing}
      ${llm}
      <td>${oracle}</td>
      <td>${issueCell}</td>
      <td>${thumb(p)}</td>
    </tr>`;
  }).join("\n");

  // Cost breakdown rows
  const costRows = costByModel.size === 0
    ? `<tr><td colspan="5" style="color:#999">No LLM calls (heuristic labels only)</td></tr>`
    : [...costByModel.entries()].map(([model, c]) => `<tr>
        <td>${escHtml(model)}</td>
        <td>${c.calls}</td>
        <td>${formatTokens(c.promptTokens)}</td>
        <td>${formatTokens(c.completionTokens)}</td>
        <td>${formatCost(c.costUsd)}</td>
      </tr>`).join("\n");

  // Issues rows — "found X → did Y" framing
  const issueRows = report.pages.filter((p) => p.status === "ok").map((p) => {
    const items: Array<{ text: string; error?: boolean }> = [];
    if (p.issues.unknownSections > 0) {
      items.push({ text: `Found ${p.issues.unknownSections} section(s) with role=unknown → labeled as "content" by heuristic (no action needed)` });
    }
    if (p.issues.labelSource === "heuristic-error") {
      const reason = p.issues.labelFallbackReason ? ` — ${p.issues.labelFallbackReason}` : "";
      items.push({
        text: `LLM labeling failed on every page${reason}; built with heuristic labels instead. Check OPENROUTER_API_KEY / LLM_PROVIDER config.`,
        error: true,
      });
    } else if (p.issues.labelSource === "heuristic-disabled") {
      items.push({ text: "LLM labeler disabled (llm:false) → used deterministic heuristic (no LLM cost / no action needed)" });
    } else if (p.issues.labelSource === "llm-cached") {
      items.push({ text: "labels.json reused from prior run → no re-cost (no action needed)" });
    }
    if (p.issues.leftoverSourceRefs > 0) {
      items.push({ text: `Found ${p.issues.leftoverSourceRefs} origin(s) still referenced in capture → all source origins are expected; rehosted assets are self-contained` });
    }
    if (items.length === 0) return "";
    return `<tr>
      <td><code>${escHtml(p.route)}</code></td>
      <td><ul style="margin:0;padding-left:18px">${items.map((i) =>
        i.error
          ? `<li style="color:#cb2431;font-weight:600">${escHtml(i.text)}</li>`
          : `<li>${escHtml(i.text)}</li>`
      ).join("")}</ul></td>
    </tr>`;
  }).filter(Boolean).join("\n") || `<tr><td colspan="2" style="color:#22863a">No issues found.</td></tr>`;

  // Cold-build summary callout
  const captureEstNote = coldCaptureHasEstimate ? ` <em style="color:#888">(capture estimated at ${formatMs(EST_FRESH_CAPTURE_MS_PER_PAGE)}/page — no recorded fresh time)</em>` : "";
  const coldSummaryHtml = captureIssuedAnyCached ? `
    <div style="margin-top:16px;padding:14px 16px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;">
      <p style="font-weight:600;margin-bottom:8px">Cold-build cost vs this run</p>
      <p style="color:#555;margin-bottom:8px">
        Capture (browser render + asset rehost) is the dominant cost — it ran in a prior session for some pages.
        This-run wall time reflects only what was <em>not</em> cached.
      </p>
      <table style="width:auto;font-size:0.9em">
        <tr>
          <td style="padding:4px 16px 4px 0;font-weight:600">Cold-build total${captureEstNote}</td>
          <td style="padding:4px 0"><strong>${formatMs(coldTotalMs)}</strong></td>
        </tr>
        <tr>
          <td style="padding:4px 16px 4px 0;color:#555">↳ capture (dominant cost)</td>
          <td style="padding:4px 0">${formatMs(coldCaptureTotal)}${coldCaptureHasEstimate ? " (est.)" : ""}</td>
        </tr>
        <tr>
          <td style="padding:4px 16px 4px 0;color:#555">↳ label + project + build</td>
          <td style="padding:4px 0">${formatMs(coldLabelTotal + coldProjectTotal + coldBuildTotal)}</td>
        </tr>
        <tr style="border-top:1px solid #ffe082">
          <td style="padding:8px 16px 4px 0;font-weight:600">This-run wall time</td>
          <td style="padding:8px 0"><strong>${formatMs(report.totalWallMs)}</strong> (cache hits skipped capture)</td>
        </tr>
      </table>
    </div>` : "";

  // LLM cached cost callout in summary
  const cachedLlmPages = okPages.filter((p) => p.issues.labelSource === "llm-cached");
  const cachedLlmCallout = cachedLlmPages.length > 0 ? `
    <p style="margin-top:8px;color:#555">
      LLM labels: <strong>${cachedLlmPages.length} page(s) reused cached labels.json</strong> — no LLM cost this run.
      Those pages paid their label cost on the first build; the labels are stable until the page is recaptured.
    </p>` : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build Report — ${escHtml(report.site)}</title>
<meta name="description" content="Milo clone-engine build report for ${escHtml(report.origin)}">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; color: #24292e; background: #f6f8fa; line-height: 1.5; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e1e4e8; color: #24292e; }
  .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  .meta { color: #586069; font-size: 0.9em; margin-top: 4px; }
  .stats { display: flex; gap: 32px; flex-wrap: wrap; margin-top: 12px; }
  .stat { }
  .stat-label { font-size: 0.8em; color: #586069; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-value { font-size: 1.5rem; font-weight: 600; color: #24292e; }
  .stat-value.ok { color: #22863a; }
  .stat-value.fail { color: #cb2431; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th { text-align: left; padding: 8px 10px; background: #f1f3f5; border: 1px solid #e1e4e8; font-weight: 600; white-space: nowrap; }
  td { padding: 8px 10px; border: 1px solid #e1e4e8; vertical-align: top; }
  tr:nth-child(even) td { background: #fafbfc; }
  code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.88em; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  .section-head { display: flex; align-items: center; gap: 8px; }
  .badge { font-size: 0.75em; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
  .badge-ok { background: #dcffe4; color: #22863a; }
  .badge-fail { background: #ffe0e0; color: #cb2431; }
  .overflow-x { overflow-x: auto; }
  footer { margin-top: 32px; color: #999; font-size: 0.8em; text-align: center; }
</style>
</head>
<body>

<div class="card">
  <h1>Build report — ${escHtml(report.site)}</h1>
  <div class="meta">${escHtml(report.origin)} &middot; Generated ${escHtml(report.generatedAt)}</div>
  <div class="stats">
    <div class="stat">
      <div class="stat-label">Pages ok</div>
      <div class="stat-value ok">${okPages.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Pages failed</div>
      <div class="stat-value fail">${failedPages.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">This-run wall</div>
      <div class="stat-value">${formatMs(report.totalWallMs)}</div>
    </div>
    ${captureIssuedAnyCached ? `<div class="stat">
      <div class="stat-label">Cold-build total</div>
      <div class="stat-value" style="font-size:1rem;color:#e36209">${formatMs(coldTotalMs)}${coldCaptureHasEstimate ? " (est.)" : ""}</div>
    </div>` : ""}
    <div class="stat">
      <div class="stat-label">LLM cost this run</div>
      <div class="stat-value">${totalLlmCostUsd > 0 ? formatCost(totalLlmCostUsd) : "$0"}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Model(s)</div>
      <div class="stat-value" style="font-size:1rem">${escHtml(modelsStr)}</div>
    </div>
  </div>
</div>

<h2>1. Summary</h2>
<div class="card">
  <p><strong>${okPages.length} of ${report.pages.length}</strong> pages built successfully. This-run wall time: <strong>${formatMs(report.totalWallMs)}</strong>.</p>
  <p style="margin-top:8px">LLM cost this run: <strong>${totalLlmCostUsd > 0 ? formatCost(totalLlmCostUsd) : "$0.00"}</strong> using <strong>${escHtml(modelsStr)}</strong>.</p>
  ${cachedLlmCallout}
  ${failedPages.length > 0 ? `<p style="margin-top:8px;color:#cb2431"><strong>${failedPages.length} failed:</strong> ${failedPages.map((p) => escHtml(p.route)).join(", ")}</p>` : ""}
  ${coldSummaryHtml}
</div>

<h2>2. Pages</h2>
<div class="card overflow-x">
  <table>
    <thead>
      <tr>
        <th>Page</th>
        <th>Status</th>
        <th>Capture</th>
        <th>Label</th>
        <th>Project</th>
        <th>Build</th>
        <th>Tokens in</th>
        <th>Tokens out</th>
        <th>LLM cost</th>
        <th>Oracle (px)</th>
        <th>Issues</th>
        <th>Thumbnail</th>
      </tr>
    </thead>
    <tbody>
      ${pageRows}
    </tbody>
  </table>
</div>

<h2>3. Cost breakdown</h2>
<div class="card overflow-x">
  <table>
    <thead>
      <tr>
        <th>Model</th>
        <th>Calls</th>
        <th>Tokens in</th>
        <th>Tokens out</th>
        <th>Cost</th>
      </tr>
    </thead>
    <tbody>
      ${costRows}
      ${costByModel.size > 0 ? `<tr style="font-weight:600;background:#f1f3f5">
        <td>Total</td>
        <td>${report.pages.filter((p) => p.llm).length}</td>
        <td>${formatTokens(report.pages.reduce((s, p) => s + (p.llm?.promptTokens ?? 0), 0))}</td>
        <td>${formatTokens(report.pages.reduce((s, p) => s + (p.llm?.completionTokens ?? 0), 0))}</td>
        <td>${formatCost(totalLlmCostUsd)}</td>
      </tr>` : ""}
    </tbody>
  </table>
</div>

<h2>4. Issues found &amp; fixed</h2>
<div class="card overflow-x">
  <table>
    <thead>
      <tr>
        <th>Page</th>
        <th>Finding → action</th>
      </tr>
    </thead>
    <tbody>
      ${issueRows}
    </tbody>
  </table>
</div>

<h2>5. Fidelity</h2>
<div class="card">
  ${fidelitySpotlight || "<p style='color:#999'>No homepage screenshot available.</p>"}
  <h3 style="margin-top:20px;font-size:1em;color:#586069">Oracle results per page</h3>
  <table style="margin-top:10px;width:auto">
    <thead>
      <tr><th>Page</th><th>Oracle (px diff)</th></tr>
    </thead>
    <tbody>
      ${report.pages.filter((p) => p.status === "ok").map((p) => `<tr>
        <td><code>${escHtml(p.route)}</code></td>
        <td>${p.oraclePx != null ? `${p.oraclePx} px` : "not measured"}</td>
      </tr>`).join("\n")}
    </tbody>
  </table>
</div>

<footer>Milo clone-engine build report &middot; ${escHtml(report.generatedAt)}</footer>

</body>
</html>`;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`[report] wrote ${outPath}`);

  // Write structured JSON alongside the HTML — same basename, .json extension.
  // Admin dashboard consumer: build-report.json is the data contract for the
  // admin UI. It contains structured per-page timing, cost, fidelity, and asset
  // data. Do not change the shape without coordinating with the admin team.
  const jsonPath = outPath.replace(/\.html$/, ".json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[report] wrote ${jsonPath}`);
}

// Re-export computeCostUsd so callers don't duplicate the rate constants.
export { computeCostUsd };
