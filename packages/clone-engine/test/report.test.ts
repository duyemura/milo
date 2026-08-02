/**
 * report.test.ts — unit tests for the generateHtmlReport() function.
 *
 * Uses only mock data — no real clone engine calls, no LLM, no capture.
 * Verifies structure and content of the generated HTML report.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateHtmlReport } from "../src/report.ts";
import type { BuildReport, PageReport } from "../src/report.ts";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockPages: PageReport[] = [
  {
    route: "/",
    status: "ok",
    timing: { route: "/", captureMs: 90_000, labelMs: 12_000, projectMs: 5_000, buildMs: 8_000, captureCached: false },
    llm: { model: "google/gemini-2.5-flash", promptTokens: 45_000, completionTokens: 2_000, costUsd: 0.005300 },
    issues: { assetsFailed: 0, leftoverSourceRefs: 3, labelSource: "llm-fresh", unknownSections: 1, captureRetries: 0, selfContainmentWarnings: 0 },
    thumbPath: undefined,
    oraclePx: 0,
    assetCount: 42,
    pageWeightKb: 128,
  },
  {
    route: "/about/",
    status: "failed",
    error: "TimeoutError: page load timed out after 30000ms",
    timing: { route: "/about/", captureMs: 30_000, labelMs: 0, projectMs: 0, buildMs: 0, captureCached: false },
    issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "heuristic-disabled", unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
  },
];

const mockReport: BuildReport = {
  site: "Test Gym",
  origin: "https://testgym.com",
  generatedAt: "2026-08-01T00:00:00.000Z",
  totalWallMs: 150_000,
  pages: mockPages,
};

// ---------------------------------------------------------------------------
// Test setup — write to temp file
// ---------------------------------------------------------------------------

let tmpDir: string;
let reportPath: string;
let reportHtml: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "milo-report-test-"));
  reportPath = path.join(tmpDir, "build-report.html");
  generateHtmlReport(mockReport, reportPath);
  reportHtml = fs.readFileSync(reportPath, "utf8");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateHtmlReport", () => {
  it("writes a file", () => {
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.statSync(reportPath).size).toBeGreaterThan(0);
  });

  it("writes build-report.json alongside the HTML", () => {
    const jsonPath = reportPath.replace(/\.html$/, ".json");
    expect(fs.existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BuildReport;
    expect(parsed.site).toBe("Test Gym");
    expect(parsed.origin).toBe("https://testgym.com");
    expect(Array.isArray(parsed.pages)).toBe(true);
  });

  it("build-report.json contains assetCount and pageWeightKb fields on the ok page", () => {
    const jsonPath = reportPath.replace(/\.html$/, ".json");
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BuildReport;
    const home = parsed.pages.find((p) => p.route === "/");
    expect(home).toBeDefined();
    // Fields exist (may be undefined or a number — they are in the type)
    expect("assetCount" in home!).toBe(true);
    expect("pageWeightKb" in home!).toBe(true);
    expect(home!.assetCount).toBe(42);
    expect(home!.pageWeightKb).toBe(128);
  });

  it("is valid HTML (contains DOCTYPE or <html)", () => {
    expect(reportHtml).toMatch(/<!DOCTYPE html>/i);
    expect(reportHtml).toMatch(/<html/i);
  });

  it("contains the section heading: Summary", () => {
    expect(reportHtml).toMatch(/Summary/i);
  });

  it("contains the section heading: Pages", () => {
    expect(reportHtml).toMatch(/Pages/i);
  });

  it("contains the section heading: Cost breakdown", () => {
    expect(reportHtml).toMatch(/Cost breakdown/i);
  });

  it("contains the section heading: Issues", () => {
    expect(reportHtml).toMatch(/Issues/i);
  });

  it("contains the section heading: Fidelity", () => {
    expect(reportHtml).toMatch(/Fidelity/i);
  });

  it("contains the site name", () => {
    expect(reportHtml).toContain("Test Gym");
  });

  it("contains the origin URL", () => {
    expect(reportHtml).toContain("https://testgym.com");
  });

  it("contains the ok page route", () => {
    expect(reportHtml).toContain("/");
  });

  it("contains the failed page route", () => {
    expect(reportHtml).toContain("/about/");
  });

  it("shows the error message for failed pages", () => {
    expect(reportHtml).toContain("TimeoutError");
  });

  it("shows the model name", () => {
    expect(reportHtml).toContain("google/gemini-2.5-flash");
  });

  it("shows oracle result for the homepage", () => {
    expect(reportHtml).toContain("0 px");
  });

  it("shows ok/failed status labels", () => {
    expect(reportHtml).toMatch(/\bok\b/);
    expect(reportHtml).toMatch(/\bfailed\b/);
  });

  it("contains the generated-at timestamp", () => {
    expect(reportHtml).toContain("2026-08-01");
  });
});

describe("generateHtmlReport: cached capture", () => {
  const cachedCapturePage: PageReport = {
    route: "/",
    status: "ok",
    timing: {
      route: "/",
      captureMs: 0,
      labelMs: 5_000,
      projectMs: 2_000,
      buildMs: 3_000,
      captureCached: true,
      freshCaptureMs: 185_000,
    },
    llm: { model: "google/gemini-2.5-flash", promptTokens: 10_000, completionTokens: 500, costUsd: 0.002 },
    issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "llm-fresh", unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
    oraclePx: 0,
  };

  const cachedReport: BuildReport = {
    site: "Cached Capture Gym",
    origin: "https://cachedcapture.com",
    generatedAt: "2026-08-01T00:00:00.000Z",
    totalWallMs: 10_000,
    pages: [cachedCapturePage],
  };

  let html: string;
  let jsonPath: string;

  beforeAll(() => {
    const outPath = path.join(os.tmpdir(), `milo-cached-capture-test-${Date.now()}.html`);
    generateHtmlReport(cachedReport, outPath);
    html = fs.readFileSync(outPath, "utf8");
    jsonPath = outPath.replace(/\.html$/, ".json");
    // cleanup after
    afterAll(() => { try { fs.unlinkSync(outPath); fs.unlinkSync(jsonPath); } catch { /* ok */ } });
  });

  it("capture cell shows 'cached' (not '0ms' or 'free')", () => {
    expect(html).toContain("cached");
  });

  it("capture cell shows the fresh-capture time (185s = 3.1m)", () => {
    // freshCaptureMs=185_000 → formatMs gives 3.1m (185000/60000 = 3.08...)
    expect(html).toContain("3.1m");
  });

  it("cold-build summary section appears when capture was cached", () => {
    expect(html).toContain("Cold-build cost vs this run");
  });

  it("cold-build summary calls out capture as the dominant cost", () => {
    expect(html).toContain("dominant cost");
  });

  it("build-report.json records captureCached=true and freshCaptureMs", () => {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as BuildReport;
    const home = parsed.pages[0];
    expect(home?.timing.captureCached).toBe(true);
    expect(home?.timing.freshCaptureMs).toBe(185_000);
  });
});

describe("generateHtmlReport: cached capture with estimated fresh time", () => {
  const estimatedPage: PageReport = {
    route: "/",
    status: "ok",
    timing: {
      route: "/",
      captureMs: 0,
      labelMs: 3_000,
      projectMs: 2_000,
      buildMs: 4_000,
      captureCached: true,
      // freshCaptureMs absent → will use EST_FRESH_CAPTURE_MS_PER_PAGE
    },
    llm: undefined,
    issues: { assetsFailed: 0, leftoverSourceRefs: 0, labelSource: "heuristic-disabled", unknownSections: 0, captureRetries: 0, selfContainmentWarnings: 0 },
  };

  const estimatedReport: BuildReport = {
    site: "Estimated Gym",
    origin: "https://estimatedgym.com",
    generatedAt: "2026-08-01T00:00:00.000Z",
    totalWallMs: 9_000,
    pages: [estimatedPage],
  };

  let html: string;

  beforeAll(() => {
    const outPath = path.join(os.tmpdir(), `milo-est-capture-test-${Date.now()}.html`);
    generateHtmlReport(estimatedReport, outPath);
    html = fs.readFileSync(outPath, "utf8");
    afterAll(() => { try { fs.unlinkSync(outPath); fs.unlinkSync(outPath.replace(/\.html$/, ".json")); } catch { /* ok */ } });
  });

  it("shows 'estimated' when freshCaptureMs is absent", () => {
    expect(html).toContain("estimated");
  });

  it("shows 'cached' in the capture cell", () => {
    expect(html).toContain("cached");
  });
});
