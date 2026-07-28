import { describe, it, expect, vi } from "vitest";
import { BusinessDoc, IntegrationsDoc } from "../src/schemas.ts";
import { buildIntegrations, classifyBusiness, classifyPage } from "../src/classify.ts";

describe("buildIntegrations", () => {
  it("maps brand analytics + software signals to IntegrationsDoc deterministically", () => {
    const doc = buildIntegrations({
      colors: {}, fonts: {}, logo: null, socialLinks: [], software: "PushPress",
      analytics: { gtm: "GTM-ABC123", ga4: "G-XYZ123", facebookPixel: "detected" }, fontFiles: [],
    });
    expect(() => IntegrationsDoc.parse(doc)).not.toThrow();
    expect(doc.analytics.gtm).toEqual({ containerId: "GTM-ABC123", detected: true });
    expect(doc.analytics.hotjar.detected).toBe(false);
    expect(doc.gymSoftware).toEqual({ platform: "PushPress", detected: true, bookingUrl: null });
  });
});

describe("classifyBusiness", () => {
  it("returns a valid BusinessDoc using LLM narrative + detected signals", async () => {
    const narrative = {
      techStack: { websiteBuilder: "WordPress", gymSoftware: "PushPress", emailPlatform: null,
        bookingMethod: "embedded widget", hasPaymentProcessing: true, hasLiveChat: false },
      marketingMaturity: { runsPaidAds: true, hasEmailList: true, doesContentMarketing: false,
        hasMemberApp: true, socialPlatforms: ["instagram"] },
      businessSignals: { locationCount: 1, coachCount: 4, pricingPoints: ["$199/mo"],
        membershipModel: ["monthly"], hasCompetitiveTeam: false },
      assessment: "Established single-location gym with solid marketing maturity.",
    };
    const chat = vi.fn().mockResolvedValue({ content: JSON.stringify(narrative) });
    const out = await classifyBusiness({
      chat, model: "fast",
      pages: [], brand: { colors: {}, fonts: {}, logo: null, socialLinks: ["https://instagram.com/x"], software: "PushPress", analytics: { facebookPixel: "detected" }, fontFiles: [] },
    });
    expect(() => BusinessDoc.parse(out)).not.toThrow();
    expect(out.techStack.gymSoftware).toBe("PushPress");
  });
});

describe("classifyPage", () => {
  it("merges LLM classification onto a page document", async () => {
    const chat = vi.fn().mockResolvedValue({ content: JSON.stringify({
      detectedType: "coaches", pageArchetype: "team", pageGoal: "build trust",
      primaryKeyword: "crossfit coaches denver", secondaryKeywords: ["certified"],
      topicsAnswered: ["who are the coaches?"], conversionSignals: ["book a session"],
    }) });
    const base = {
      url: "https://g.com/coaches", slug: "coaches", title: "Coaches", metaDescription: "",
      headings: ["Meet the team"], bodyText: "coach bios", images: [], links: [],
      fetchMethod: "static" as const, detectedType: "other", pageArchetype: "other",
      pageGoal: "inform", primaryKeyword: "", secondaryKeywords: [], topicsAnswered: [], conversionSignals: [],
    };
    const out = await classifyPage(base, { chat, model: "fast" });
    expect(out.detectedType).toBe("coaches");
    expect(out.pageArchetype).toBe("team");
    expect(out.bodyText).toBe("coach bios");  // preserved
  });
});
