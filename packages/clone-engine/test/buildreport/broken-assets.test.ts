import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkBrokenAssets } from "../../src/buildreport/checks/broken-assets.ts";
import { makeSiteDir, makeCtx } from "./fixtures.ts";

describe("checkBrokenAssets", () => {
  it("returns no issues when all images exist on disk", async () => {
    const siteDir = makeSiteDir({ distHtml: '<img src="/assets/logo.png"><p>ok</p>' });
    fs.mkdirSync(path.join(siteDir, "astro/dist/assets"), { recursive: true });
    fs.writeFileSync(path.join(siteDir, "astro/dist/assets/logo.png"), "fake-png");
    const result = await checkBrokenAssets(makeCtx(siteDir));
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when an image src resolves to a missing file", async () => {
    const siteDir = makeSiteDir({ distHtml: '<img src="/assets/missing.png"><p>ok</p>' });
    const result = await checkBrokenAssets(makeCtx(siteDir));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("blocker");
    expect(result.issues[0].kind).toBe("broken-asset");
    expect(result.issues[0].detail).toContain("missing.png");
  });

  it("blocks when a CSS background-image url() references a missing file", async () => {
    const siteDir = makeSiteDir({ distHtml: '<style>body{background-image:url("/bg.jpg")}</style>' });
    const result = await checkBrokenAssets(makeCtx(siteDir));
    expect(result.issues.some((i) => i.kind === "broken-asset" && i.detail.includes("bg.jpg"))).toBe(true);
  });

  it("skips external URLs and data URIs", async () => {
    const siteDir = makeSiteDir({ distHtml: '<img src="https://external.com/img.png"><img src="data:image/png;base64,abc">' });
    const result = await checkBrokenAssets(makeCtx(siteDir));
    expect(result.issues).toHaveLength(0);
  });
});
