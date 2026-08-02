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
    timing: { route: "/", captureMs: 90_000, labelMs: 12_000, projectMs: 5_000, buildMs: 8_000 },
    llm: { model: "google/gemini-2.5-flash", promptTokens: 45_000, completionTokens: 2_000, costUsd: 0.005300 },
    issues: { assetsFailed: 0, leftoverSourceRefs: 3, labelSource: "llm-fresh", unknownSections: 1, captureRetries: 0, selfContainmentWarnings: 0 },
    thumbPath: undefined,
    oraclePx: 0,
  },
  {
    route: "/about/",
    status: "failed",
    error: "TimeoutError: page load timed out after 30000ms",
    timing: { route: "/about/", captureMs: 30_000, labelMs: 0, projectMs: 0, buildMs: 0 },
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
