import { describe, it, expect, vi } from "vitest";
import { GymDocuments } from "@milo/schema";
import { budgetPages, synthesize } from "../src/synthesize.ts";
import type { PageDocument } from "../src/schemas.ts";

function page(slug: string, budget: "full" | "truncated", chars: number): PageDocument {
  return {
    url: `https://g.com/${slug}`, slug, title: slug, metaDescription: "", headings: [],
    bodyText: "y".repeat(chars), images: [], links: [], fetchMethod: "static",
    detectedType: "other", pageArchetype: "other", pageGoal: "inform",
    primaryKeyword: "", secondaryKeywords: [], topicsAnswered: [], conversionSignals: [],
    // carry budget out-of-band for the test
  } as unknown as PageDocument & { llmBudget?: string };
}

describe("budgetPages", () => {
  it("truncates full pages progressively until under the char ceiling", () => {
    const pages = [page("a", "full", 5000), page("b", "full", 5000)];
    const budgets = new Map([["a", "full"], ["b", "full"]] as const);
    const out = budgetPages(pages, budgets, 4000); // ceiling 4000 chars total
    expect(out.reduce((n, p) => n + p.bodyText.length, 0)).toBeLessThanOrEqual(4000);
  });
});

// Hoisted fixtures — shared by both `synthesize` it-blocks.
const gym = {
  identity: { name: "Iron Anchor", tagline: "Strength for real life" },
  brand: {
    colors: { primary: "#0b1f3a", accent: "#e63946", surface: "#ffffff", text: "#1a1a1a", muted: "#8a8a8a" },
    fonts: { display: "Oswald", body: "Inter" },
    space: { sm: "8px", md: "16px", lg: "32px" }, radius: { button: "6px", card: "12px" },
  },
  hierarchy: { pages: [{ slug: "index", title: "Home", meta: { description: "d" },
    sections: [{ section: "hero", content: { heading: "Welcome", image: { src: "/assets/hero.jpg", alt: "gym" } } }] }] },
};

const context = {
  icp: { fitnessLevel: "beginner-friendly", ageRange: "25-45", lifestage: ["parents"], primaryGoals: ["community"], psychographics: "x" },
  brandVoice: { tone: "direct", avoids: [], emphasizes: [], communicationStyle: "you" },
  positioning: { headline: "h", differentiators: [], vsCompetition: "", competitivePositioning: "" },
  painPointsAddressed: [], primaryOffer: "Free intro", pricingTier: "mid-market",
  memberTransformationLanguage: [], commonObjections: [], contentPillars: [], coachAuthoritySignals: [],
  socialProof: { yearsOpen: 11, memberCount: "500+", mediaAchievements: [], reviewHighlights: [] },
  geographicContext: { neighborhood: "LoDo", city: "Denver", localCultureSignals: [], areaServed: [] },
  seasonalCampaigns: [], siteArchitecture: [{ slug: "index", archetype: "homepage", goal: "convert" }],
};

describe("synthesize", () => {
  it("returns a valid GymDocuments + ContextDoc from LLM output", async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({ content: JSON.stringify(gym) })
      .mockResolvedValueOnce({ content: JSON.stringify(context) });

    const out = await synthesize({
      chat, model: "capable-model",
      pages: [page("index", "full", 300)],
      budgets: new Map([["index", "full"]]),
      identity: { found: true, name: "Iron Anchor" },
      brand: { colors: {}, fonts: {}, logo: null, socialLinks: [], software: null, analytics: {}, fontFiles: [] },
    });

    expect(() => GymDocuments.parse(out.gym)).not.toThrow();
    expect(out.gym.identity.name).toBe("Iron Anchor");
    expect(out.context.primaryOffer).toBe("Free intro");
  });

  it("retries when a section's content is invalid (strict deep validation)", async () => {
    // First gym response has a hero with NO image -> fails Section validation -> retry.
    const badGym = structuredClone(gym);
    // deliberately omit image on the hero
    badGym.hierarchy.pages[0].sections[0] = { section: "hero", content: { heading: "Welcome" } };
    const chat = vi.fn()
      .mockResolvedValueOnce({ content: JSON.stringify(badGym) })   // rejected by strict refine
      .mockResolvedValueOnce({ content: JSON.stringify(gym) })      // corrected
      .mockResolvedValueOnce({ content: JSON.stringify(context) }); // context pass
    const out = await synthesize({
      chat, model: "capable-model", pages: [page("index", "full", 300)],
      budgets: new Map([["index", "full"]]),
      identity: { found: true, name: "Iron Anchor" },
      brand: { colors: {}, fonts: {}, logo: null, socialLinks: [], software: null, analytics: {}, fontFiles: [] },
    });
    expect(chat.mock.calls.length).toBe(3);           // 2 gym attempts + 1 context
    expect(() => GymDocuments.parse(out.gym)).not.toThrow();
  });
});
