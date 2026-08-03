import { describe, it, expect } from "vitest";
import { renderSiteReport } from "../../src/buildreport/render.ts";
import type { SiteReport } from "../../src/buildreport/types.ts";

const makeReport = (verdict: "SHIP" | "NEEDS_FIXES", blockers: number): SiteReport => ({
  verdict, blockerCount: blockers, noteCount: 0, infoCount: 2,
  issues: blockers > 0 ? [{ severity: "blocker", page: "/", kind: "broken-asset", detail: "logo.png missing" }] : [],
  pages: [{ route: "/", issues: [], pageWeightKb: 42 }],
  generatedAt: "2026-08-02T00:00:00.000Z",
});

describe("renderSiteReport", () => {
  it("SHIP verdict contains SHIP and zero blockers message", () => {
    const html = renderSiteReport(makeReport("SHIP", 0));
    expect(html).toContain("SHIP");
    expect(html).toContain("zero blockers");
  });

  it("NEEDS_FIXES verdict contains blocker count and issue detail", () => {
    const html = renderSiteReport(makeReport("NEEDS_FIXES", 1));
    expect(html).toContain("NEEDS_FIXES");
    expect(html).toContain("1 blocker");
    expect(html).toContain("logo.png missing");
  });

  it("produces valid HTML with doctype", () => {
    const html = renderSiteReport(makeReport("SHIP", 0));
    expect(html.trim().toLowerCase()).toMatch(/^<!doctype html>/);
  });

  it("includes page weight in the output", () => {
    const html = renderSiteReport(makeReport("SHIP", 0));
    expect(html).toContain("42");
  });
});
