import { describe, it, expect } from "vitest";
import { checkPagespeed } from "../../src/buildreport/checks/pagespeed.ts";
import { makeSiteDir, makeCtx } from "./fixtures.ts";

describe("checkPagespeed", () => {
  it("returns pagespeed-weight as info issue", async () => {
    const siteDir = makeSiteDir();
    const result = await checkPagespeed(makeCtx(siteDir));
    expect(result.issues.some((i) => i.kind === "pagespeed-weight")).toBe(true);
    expect(result.issues[0].severity).toBe("info");
  });

  it("all issues are info severity only", async () => {
    const siteDir = makeSiteDir();
    const result = await checkPagespeed(makeCtx(siteDir));
    for (const issue of result.issues) expect(issue.severity).toBe("info");
  });
});
