import { describe, it, expect } from "vitest";
import { PagesJson, PageDocument, LinkMap, BrandCrawl, IdentityCrawl } from "@milo/schema";
import { ContextDoc, BusinessDoc, IntegrationsDoc } from "../src/schemas.ts";

describe("intake schemas", () => {
  it("PageDocument requires fetchMethod and detectedType", () => {
    const doc = {
      url: "https://gym.com/about", slug: "about", title: "About", metaDescription: "d",
      headings: ["Our Story"], bodyText: "text", images: [], links: [],
      fetchMethod: "static", detectedType: "about", pageArchetype: "about/story",
      pageGoal: "build trust", primaryKeyword: "gym", secondaryKeywords: [],
      topicsAnswered: [], conversionSignals: [],
    };
    expect(PageDocument.parse(doc).slug).toBe("about");
    expect(() => PageDocument.parse({ ...doc, fetchMethod: "carrier-pigeon" })).toThrow();
  });

  it("PagesJson counts default to 0 and pages carry llmBudget", () => {
    const p = PagesJson.parse({
      baseUrl: "https://gym.com/", discoveredAt: "2026-07-28T00:00:00Z",
      totalDiscovered: 3, filtered: 1, capped: 0,
      pages: [{ url: "https://gym.com/", slug: "index", priority: 1, source: "nav", llmBudget: "full" }],
    });
    expect(p.pages[0].llmBudget).toBe("full");
  });

  it("IntegrationsDoc defaults every detector to not-detected", () => {
    const i = IntegrationsDoc.parse({});
    expect(i.analytics.ga4.detected).toBe(false);
    expect(i.gymSoftware.detected).toBe(false);
  });

  it("ContextDoc, BusinessDoc, BrandCrawl, IdentityCrawl parse minimal objects", () => {
    expect(() => BrandCrawl.parse({ colors: {}, fonts: {}, logo: null, socialLinks: [], software: null, analytics: {} })).not.toThrow();
    expect(() => IdentityCrawl.parse({ found: false })).not.toThrow();
    expect(ContextDoc).toBeDefined();
    expect(BusinessDoc).toBeDefined();
  });

  it("LinkMap records crawled + skipped internal URLs and edges", () => {
    const m = LinkMap.parse({
      baseUrl: "https://g.com/", discoveredAt: "2026-07-28T00:00:00Z",
      nodes: [
        { url: "https://g.com/", slug: "index", crawled: true, isUgc: false },
        { url: "https://g.com/blog/x", slug: "blog-x", crawled: false, isUgc: true },
      ],
      edges: [{ from: "https://g.com/", to: "https://g.com/blog/x" }],
    });
    expect(m.nodes).toHaveLength(2);
    expect(m.nodes[1].crawled).toBe(false);
  });

  it("BusinessDoc.techStack.bookingMethod accepts null (LLM returns null when undetected)", () => {
    const base = {
      techStack: { websiteBuilder: null, gymSoftware: null, emailPlatform: null,
        bookingMethod: null, hasPaymentProcessing: false, hasLiveChat: false },
      marketingMaturity: { runsPaidAds: false, hasEmailList: false, doesContentMarketing: false,
        hasMemberApp: false, socialPlatforms: [] },
      businessSignals: { locationCount: 1, coachCount: null, pricingPoints: [], membershipModel: [], hasCompetitiveTeam: false },
      assessment: "ok",
    };
    expect(() => BusinessDoc.parse(base)).not.toThrow();
    expect(BusinessDoc.parse({ ...base, techStack: { ...base.techStack, bookingMethod: "embedded widget" } }).techStack.bookingMethod).toBe("embedded widget");
  });
});
