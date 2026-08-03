import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkIframes } from "../../src/buildreport/checks/iframes.ts";
import { makeSiteDir, makeCaptureDir, makeCtx } from "./fixtures.ts";

describe("checkIframes", () => {
  it("no issues when source has no iframes", async () => {
    const siteDir = makeSiteDir();
    const captureDir = makeCaptureDir({ iframeSrcs: [] });
    const result = await checkIframes({ ...makeCtx(siteDir), source: { captureDir } });
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when source iframe is absent from clone", async () => {
    const captureDir = makeCaptureDir({ iframeSrcs: ["https://maps.google.com/embed?q=gym"] });
    const siteDir = makeSiteDir({ distHtml: "<p>no iframe</p>" });
    const result = await checkIframes({ ...makeCtx(siteDir), source: { captureDir } });
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "dropped-iframe")).toBe(true);
  });

  it("notes same-domain iframes", async () => {
    const src = "https://sourcegym.com/booking";
    const captureDir = makeCaptureDir({ iframeSrcs: [src], sourceOrigins: ["https://sourcegym.com"] });
    const siteDir = makeSiteDir({ distHtml: `<iframe src="${src}"></iframe>` });
    const result = await checkIframes({ ...makeCtx(siteDir), source: { captureDir } });
    expect(result.issues.some((i) => i.severity === "note" && i.kind === "same-domain-iframe")).toBe(true);
  });

  it("no issues when source not provided (skipped)", async () => {
    const siteDir = makeSiteDir();
    const result = await checkIframes(makeCtx(siteDir));
    expect(result.issues).toHaveLength(0);
  });
});
