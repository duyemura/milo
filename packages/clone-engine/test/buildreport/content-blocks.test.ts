import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkContentBlocks } from "../../src/buildreport/checks/content-blocks.ts";
import { makeSiteDir, makeCtx } from "./fixtures.ts";

describe("checkContentBlocks", () => {
  it("no issues when all sections present and have content", async () => {
    const siteDir = makeSiteDir();
    const result = await checkContentBlocks(makeCtx(siteDir));
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when a section from site.json is absent in built HTML", async () => {
    const siteDir = makeSiteDir({ distHtml: "<p>no sections here</p>" });
    const result = await checkContentBlocks(makeCtx(siteDir));
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "missing-section")).toBe(true);
  });

  it("blocks when a section exists but has no text content", async () => {
    const siteDir = makeSiteDir({
      siteJsonSections: [{ name: "HeroSection", role: "hero", copyKeys: ["HeroSection.0"] }],
      distHtml: '<section data-component="HeroSection" data-section="hero">   </section>',
    });
    const result = await checkContentBlocks(makeCtx(siteDir));
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "empty-section")).toBe(true);
  });
});
