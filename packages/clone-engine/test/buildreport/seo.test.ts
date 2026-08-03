import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkSeo } from "../../src/buildreport/checks/seo.ts";
import { makeSiteDir, makeCaptureDir, makeCtx } from "./fixtures.ts";

describe("checkSeo", () => {
  it("no blockers on a well-formed page", async () => {
    const siteDir = makeSiteDir({ distHtml: '<h1>Heading</h1><img alt="logo" src="/logo.png">' });
    const result = await checkSeo(makeCtx(siteDir));
    expect(result.issues.filter((i) => i.severity === "blocker")).toHaveLength(0);
  });

  it("info when h1 is missing", async () => {
    const siteDir = makeSiteDir({ distHtml: "<p>no heading</p>" });
    const result = await checkSeo(makeCtx(siteDir));
    expect(result.issues.some((i) => i.kind === "seo-missing-h1")).toBe(true);
  });

  it("blocker when source had a title but clone does not", async () => {
    const captureDir = makeCaptureDir({ title: "Source Title", description: "desc" });
    const siteDir = makeSiteDir();
    const distPath = path.join(siteDir, "astro/dist/index.html");
    fs.writeFileSync(distPath, "<!doctype html><html><head></head><body><h1>H</h1></body></html>");
    const ctx = { ...makeCtx(siteDir, fs.readFileSync(distPath, "utf8")), source: { captureDir } };
    const result = await checkSeo(ctx);
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "seo-regression")).toBe(true);
  });

  it("no regression blocker when source also lacked description", async () => {
    const captureDir = makeCaptureDir({ title: "Title", description: "" });
    const siteDir = makeSiteDir();
    const distPath = path.join(siteDir, "astro/dist/index.html");
    fs.writeFileSync(distPath, "<!doctype html><html><head><title>Title</title></head><body><h1>H</h1></body></html>");
    const ctx = { ...makeCtx(siteDir, fs.readFileSync(distPath, "utf8")), source: { captureDir } };
    const result = await checkSeo(ctx);
    expect(result.issues.filter((i) => i.severity === "blocker" && i.kind === "seo-regression")).toHaveLength(0);
  });
});
