/**
 * orchestrate-label.test.ts — unit tests for the LLM label integration in buildSite.
 *
 * Tests cover:
 * 1. Cost accumulator delta helpers (indirectly via accumulatorTotal logic).
 * 2. Report cost plumbing: a PageReport with llm data is correctly reflected in the
 *    HTML report's cost breakdown.
 * 3. llm:false path: the report marks pages as heuristic-disabled (benign).
 * 4. heuristic-error vs heuristic-disabled: key-missing error shows RED actionable
 *    text; intentional llm:false shows benign "no action needed" copy.
 * 5. Honest source states: llm-fresh, llm-cached, heuristic-disabled, heuristic-error
 *    each produce distinct report output.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateHtmlReport } from "../src/report.ts";
import type { BuildReport, PageReport } from "../src/report.ts";

// ---------------------------------------------------------------------------
// Helpers: simulate the cost plumbing that orchestrate.ts does
// ---------------------------------------------------------------------------

/**
 * Replicate the computeLabelCost logic from orchestrate.ts so we can test
 * the expected cost arithmetic independently.
 */
function computeLabelCost(promptTokens: number, completionTokens: number): number {
  const COST_PER_M_INPUT_USD = 0.10;
  const COST_PER_M_OUTPUT_USD = 0.40;
  return (promptTokens / 1_000_000) * COST_PER_M_INPUT_USD +
    (completionTokens / 1_000_000) * COST_PER_M_OUTPUT_USD;
}

// ---------------------------------------------------------------------------
// Report integration tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "milo-orch-label-test-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cost arithmetic (computeLabelCost)", () => {
  it("charges $0 for 0 tokens", () => {
    expect(computeLabelCost(0, 0)).toBe(0);
  });

  it("charges the correct rate for 1M input + 1M output tokens", () => {
    // $0.10 input + $0.40 output = $0.50 for 1M each
    expect(computeLabelCost(1_000_000, 1_000_000)).toBeCloseTo(0.50, 6);
  });

  it("typical page: ~3k input + 300 output ≈ $0.000420", () => {
    const cost = computeLabelCost(3_000, 300);
    // (3000 / 1e6) * 0.10 + (300 / 1e6) * 0.40 = 0.0003 + 0.00012 = 0.00042
    expect(cost).toBeCloseTo(0.00042, 6);
  });
});

describe("report: LLM cost shown when pages have llm data", () => {
  const pagesWithLlm: PageReport[] = [
    {
      route: "/",
      status: "ok",
      timing: { route: "/", captureMs: 0, labelMs: 5_000, projectMs: 1_000, buildMs: 2_000, captureCached: false },
      llm: {
        model: "google/gemini-2.5-flash",
        promptTokens: 3_000,
        completionTokens: 300,
        costUsd: computeLabelCost(3_000, 300),
      },
      issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "llm-fresh" as const, unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
    },
    {
      route: "/about/",
      status: "ok",
      timing: { route: "/about/", captureMs: 0, labelMs: 4_800, projectMs: 900, buildMs: 1_800, captureCached: false },
      llm: {
        model: "google/gemini-2.5-flash",
        promptTokens: 2_800,
        completionTokens: 280,
        costUsd: computeLabelCost(2_800, 280),
      },
      issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "llm-fresh" as const, unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
    },
  ];

  const report: BuildReport = {
    site: "Test Gym",
    origin: "https://testgym.com",
    generatedAt: "2026-08-01T00:00:00.000Z",
    totalWallMs: 20_000,
    pages: pagesWithLlm,
  };

  let html: string;

  beforeAll(() => {
    const reportPath = path.join(tmpDir, "report-with-llm.html");
    generateHtmlReport(report, reportPath);
    html = fs.readFileSync(reportPath, "utf8");
  });

  it("shows the model name in the report", () => {
    expect(html).toContain("google/gemini-2.5-flash");
  });

  it("does not show 'heuristic only' when all pages had LLM calls", () => {
    expect(html).not.toContain("heuristic only");
  });

  it("shows a non-zero total LLM cost", () => {
    // Total cost should be > $0 (both pages ran LLM).
    const totalCost = pagesWithLlm.reduce((sum, p) => sum + (p.llm?.costUsd ?? 0), 0);
    expect(totalCost).toBeGreaterThan(0);
    // formatCost() returns "<$0.001" for amounts < $0.001 — both pages are tiny costs.
    // Verify the cost is represented (either as "<$0.001" for small amounts or "$X.XXXX").
    expect(html).toMatch(/<\$0\.001|\$0\.\d{4}/);
  });

  it("shows per-page token counts", () => {
    // Both pages' token counts should appear somewhere in the table.
    expect(html).toContain("3.0k");  // 3,000 prompt tokens formatted
    expect(html).toContain("300");   // 300 completion tokens
  });
});

describe("report: heuristic-disabled path (llm:false) — benign, no LLM cost shown", () => {
  const pagesHeuristic: PageReport[] = [
    {
      route: "/",
      status: "ok",
      timing: { route: "/", captureMs: 0, labelMs: 1_000, projectMs: 900, buildMs: 1_500, captureCached: false },
      // llm is undefined → heuristic-disabled (intentional)
      llm: undefined,
      issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "heuristic-disabled" as const, unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
    },
  ];

  const report: BuildReport = {
    site: "Heuristic Gym",
    origin: "https://heuristicgym.com",
    generatedAt: "2026-08-01T00:00:00.000Z",
    totalWallMs: 5_000,
    pages: pagesHeuristic,
  };

  let html: string;

  beforeAll(() => {
    const reportPath = path.join(tmpDir, "report-heuristic.html");
    generateHtmlReport(report, reportPath);
    html = fs.readFileSync(reportPath, "utf8");
  });

  it("shows 'heuristic only' when no pages have LLM data", () => {
    // The model summary shows "heuristic only" when modelSet is empty.
    expect(html).toContain("heuristic only");
  });

  it("shows 'No LLM calls' in the cost table", () => {
    expect(html).toContain("No LLM calls");
  });

  it("total cost is $0 in the summary", () => {
    // When all pages are heuristic, the summary stat shows $0.
    expect(html).toContain("$0");
  });

  it("shows 'no action needed' copy (benign — not an error)", () => {
    // heuristic-disabled is intentional — report says no action needed
    expect(html).toContain("no action needed");
  });

  it("does NOT show red LLM-error copy", () => {
    // An intentional heuristic run must not look like an error.
    expect(html).not.toContain("check OPENROUTER_API_KEY");
  });
});

describe("report: heuristic-error — LLM was attempted but failed (RED, actionable)", () => {
  const pagesError: PageReport[] = [
    {
      route: "/",
      status: "ok",
      timing: { route: "/", captureMs: 0, labelMs: 500, projectMs: 900, buildMs: 1_500, captureCached: false },
      llm: undefined, // no LLM cost because it failed
      issues: {
        assetsFailed: 0,
        leftoverSourceRefs: 0,
        labelSource: "heuristic-error" as const,
        labelFallbackReason: "HTTP 401 Unauthorized",
        unknownSections: 0,
        captureRetries: 0,
        selfContainmentWarnings: 0,
      },
    },
  ];

  const report: BuildReport = {
    site: "Error Gym",
    origin: "https://errorgym.com",
    generatedAt: "2026-08-01T00:00:00.000Z",
    totalWallMs: 5_000,
    pages: pagesError,
  };

  let html: string;

  beforeAll(() => {
    const reportPath = path.join(tmpDir, "report-error.html");
    generateHtmlReport(report, reportPath);
    html = fs.readFileSync(reportPath, "utf8");
  });

  it("shows the error reason (HTTP 401) in the report", () => {
    expect(html).toContain("HTTP 401 Unauthorized");
  });

  it("shows actionable key-check copy", () => {
    expect(html).toContain("OPENROUTER_API_KEY");
  });

  it("shows 'LLM labeling failed' text", () => {
    expect(html).toContain("LLM labeling failed");
  });

  it("does NOT show benign 'no action needed' copy for this error page", () => {
    expect(html).not.toContain("no action needed");
  });

  it("renders the error in red (cb2431 color)", () => {
    // The error copy should be rendered with the error color, not the warning orange.
    expect(html).toContain("#cb2431");
  });
});

describe("report: mixed — one LLM-fresh page + one heuristic-error page", () => {
  const pagesMixed: PageReport[] = [
    {
      route: "/",
      status: "ok",
      timing: { route: "/", captureMs: 0, labelMs: 5_000, projectMs: 1_000, buildMs: 2_000, captureCached: false },
      llm: {
        model: "google/gemini-2.5-flash",
        promptTokens: 3_000,
        completionTokens: 300,
        costUsd: computeLabelCost(3_000, 300),
      },
      issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "llm-fresh" as const, unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
    },
    {
      route: "/schedule/",
      status: "ok",
      timing: { route: "/schedule/", captureMs: 0, labelMs: 800, projectMs: 900, buildMs: 1_500, captureCached: false },
      // This page fell back to heuristic (LLM error).
      llm: undefined,
      issues: {
        assetsFailed: 0,
        leftoverSourceRefs: 0,
        labelSource: "heuristic-error" as const,
        labelFallbackReason: "HTTP 401 Unauthorized",
        unknownSections: 0,
        captureRetries: 0,
        selfContainmentWarnings: 0,
      },
    },
  ];

  const report: BuildReport = {
    site: "Mixed Gym",
    origin: "https://mixedgym.com",
    generatedAt: "2026-08-01T00:00:00.000Z",
    totalWallMs: 12_000,
    pages: pagesMixed,
  };

  let html: string;

  beforeAll(() => {
    const reportPath = path.join(tmpDir, "report-mixed.html");
    generateHtmlReport(report, reportPath);
    html = fs.readFileSync(reportPath, "utf8");
  });

  it("shows the model name (from the LLM page)", () => {
    expect(html).toContain("google/gemini-2.5-flash");
  });

  it("shows 'heuristic' cell for the fallback page", () => {
    // The non-LLM page row shows "heuristic" in the cost columns.
    expect(html).toContain("heuristic");
  });

  it("shows LLM error info for the failed page", () => {
    expect(html).toContain("LLM labeling failed");
  });

  it("shows the error reason in the issues table", () => {
    expect(html).toContain("HTTP 401 Unauthorized");
  });

  it("the homepage LLM-fresh page shows 'clean' (no issues)", () => {
    // The / page is llm-fresh and has no issues — it should show "clean"
    expect(html).toContain("clean");
  });
});

describe("report: llm-cached — labels.json reused, no re-cost (benign)", () => {
  const pagesCached: PageReport[] = [
    {
      route: "/",
      status: "ok",
      timing: { route: "/", captureMs: 0, labelMs: 50, projectMs: 900, buildMs: 1_500, captureCached: false },
      llm: undefined, // no new LLM cost — reused prior labels.json
      issues: {
        assetsFailed: 0,
        leftoverSourceRefs: 0,
        labelSource: "llm-cached" as const,
        unknownSections: 0,
        captureRetries: 0,
        selfContainmentWarnings: 0,
      },
    },
  ];

  const report: BuildReport = {
    site: "Cached Gym",
    origin: "https://cachedgym.com",
    generatedAt: "2026-08-01T00:00:00.000Z",
    totalWallMs: 5_000,
    pages: pagesCached,
  };

  let html: string;
  let reportPath: string;

  beforeAll(() => {
    reportPath = path.join(tmpDir, "report-cached.html");
    generateHtmlReport(report, reportPath);
    html = fs.readFileSync(reportPath, "utf8");
  });

  it("shows 'labels cached' in the issues cell", () => {
    expect(html).toContain("labels cached");
  });

  it("shows 'no re-cost' copy (benign)", () => {
    expect(html).toContain("no re-cost");
  });

  it("does NOT show LLM error copy", () => {
    expect(html).not.toContain("check OPENROUTER_API_KEY");
    expect(html).not.toContain("LLM labeling failed");
  });

  it("LLM cost cell shows 'cached (paid on first build)' not just '$0'", () => {
    // llm-cached must NOT read as free — it shows that cost was already paid
    expect(html).toContain("paid on first build");
    // Must not silently show $0 as the only representation
    expect(html).not.toMatch(/>\$0\.0000</);
  });

  it("shows 'reused' copy confirming labels were not re-generated", () => {
    // The issues section says labels were reused
    expect(html).toMatch(/reused/i);
  });

  it("build-report.json is written alongside the HTML", () => {
    const jsonPath = reportPath.replace(/\.html$/, ".json");
    expect(fs.existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BuildReport;
    expect(parsed.site).toBe("Cached Gym");
    expect(parsed.pages[0]?.issues.labelSource).toBe("llm-cached");
  });
});
