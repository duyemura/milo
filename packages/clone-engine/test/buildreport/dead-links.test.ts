import { describe, it, expect } from "vitest";
import { checkDeadLinks } from "../../src/buildreport/checks/dead-links.ts";
import { makeSiteDir, makeCtx } from "./fixtures.ts";

describe("checkDeadLinks", () => {
  it("no issues when all internal links resolve to built routes", async () => {
    const siteDir = makeSiteDir({ distHtml: '<a href="/">Home</a>' });
    const result = await checkDeadLinks(makeCtx(siteDir));
    expect(result.issues).toHaveLength(0);
  });

  it("blocks when an internal link has no matching built page", async () => {
    const siteDir = makeSiteDir({ distHtml: '<a href="/missing-page/">Go there</a>' });
    const result = await checkDeadLinks(makeCtx(siteDir));
    expect(result.issues.some((i) => i.severity === "blocker" && i.kind === "dead-link")).toBe(true);
  });

  it("skips external, mailto, tel, and hash-only links", async () => {
    const siteDir = makeSiteDir({ distHtml: '<a href="https://example.com">ext</a><a href="mailto:a@b.com">mail</a><a href="#section">hash</a><a href="tel:+1234">tel</a>' });
    const result = await checkDeadLinks(makeCtx(siteDir));
    expect(result.issues).toHaveLength(0);
  });
});
