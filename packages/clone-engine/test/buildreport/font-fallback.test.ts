import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkFontFallback } from "../../src/buildreport/checks/font-fallback.ts";
import { makeSiteDir, makeCtx } from "./fixtures.ts";

describe("checkFontFallback", () => {
  it("no issues when brand font is referenced in global.css", async () => {
    const siteDir = makeSiteDir({ brandFonts: [{ slot: "display", family: "Bebas Neue" }] });
    const result = await checkFontFallback(makeCtx(siteDir));
    expect(result.issues.filter((i) => i.kind === "font-fallback")).toHaveLength(0);
  });

  it("note when brand font family is not referenced in global.css", async () => {
    const siteDir = makeSiteDir({ brandFonts: [{ slot: "display", family: "MyMissingFont" }] });
    fs.writeFileSync(path.join(siteDir, "astro/src/styles/global.css"), "/* empty */");
    const result = await checkFontFallback(makeCtx(siteDir));
    expect(result.issues.some((i) => i.severity === "note" && i.kind === "font-fallback")).toBe(true);
  });

  it("all issues are note severity — never blocks", async () => {
    const siteDir = makeSiteDir({ brandFonts: [{ slot: "display", family: "Gone" }] });
    fs.writeFileSync(path.join(siteDir, "astro/src/styles/global.css"), "/* empty */");
    const result = await checkFontFallback(makeCtx(siteDir));
    for (const issue of result.issues) expect(issue.severity).not.toBe("blocker");
  });
});
