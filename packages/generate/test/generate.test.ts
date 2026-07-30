import { describe, it, expect } from "vitest";
import { GymDocuments } from "@milo/schema";
import type { PageDocument, IdentityCrawl, BrandCrawl } from "@milo/schema";
import { generateSite, sectionShapeGuide, budgetPages } from "../src/generate.ts";
import { fakeChat } from "./fakes.ts";

const IDENTITY: IdentityCrawl = {
  found: true,
  name: "Iron Anchor",
  formattedAddress: "1 Dock St, Denver, CO 80202, USA",
  phone: "+1 555-1234",
};

const BRAND: BrandCrawl = {
  colors: { "#0b1f3a": 12, "#e63946": 5, "#ffffff": 20 },
  fonts: { display: "Oswald", body: "Inter" },
  logo: "https://ironanchor.com/logo.svg",
  socialLinks: ["https://instagram.com/ironanchor"],
  software: null,
  analytics: {},
};

const PAGE: PageDocument = {
  url: "https://ironanchor.com/",
  slug: "index",
  title: "Iron Anchor — Strength for real life",
  metaDescription: "Strength for real life",
  headings: ["Welcome to Iron Anchor"],
  bodyText: "We build strength for regular people. ".repeat(20),
  images: [{ src: "https://ironanchor.com/hero.jpg", alt: "gym", localPath: null }],
  links: ["https://ironanchor.com/about"],
  fetchMethod: "static",
  detectedType: "homepage",
  pageArchetype: "home",
  pageGoal: "convert",
  primaryKeyword: "gym",
  secondaryKeywords: [],
  topicsAnswered: [],
  conversionSignals: [],
};

const GYM_JSON = {
  identity: { name: "Iron Anchor", tagline: "Strength for real life" },
  brand: {
    colors: { primary: "#0b1f3a", accent: "#e63946", surface: "#ffffff", text: "#1a1a1a", muted: "#8a8a8a" },
    fonts: { display: "Oswald", body: "Inter" },
    space: { sm: "8px", md: "16px", lg: "32px" },
    radius: { button: "6px", card: "12px" },
  },
  hierarchy: {
    pages: [{
      slug: "index",
      title: "Iron Anchor",
      meta: { description: "Strength for real life" },
      sections: [{ section: "hero", content: { heading: "Welcome", image: { src: "https://ironanchor.com/hero.jpg", alt: "gym" } } }],
    }],
  },
};

const CONTEXT = { positioning: { headline: "Strength for real life" } };
const BUSINESS = { techStack: { bookingMethod: "phone only" } };

describe("generateSite", () => {
  it("returns a valid GymDocuments from well-formed LLM output", async () => {
    const result = await generateSite({
      chat: fakeChat([JSON.stringify(GYM_JSON)]),
      model: "capable",
      identity: IDENTITY,
      brand: BRAND,
      pages: [PAGE],
      budgets: new Map([["index", "full"]]),
    });
    expect(() => GymDocuments.parse(result.gym)).not.toThrow();
    expect(result.gym.identity.name).toBe("Iron Anchor");
  });

  it("includes section shape guide and identity name in the prompt", async () => {
    let captured: { messages: { role: string; content: string }[] } | undefined;
    const chat = async (opts: { messages: { role: string; content: string }[] }) => {
      captured = opts;
      return { content: JSON.stringify(GYM_JSON) };
    };
    await generateSite({ chat, model: "capable", identity: IDENTITY, brand: BRAND, pages: [PAGE], budgets: new Map() });
    const prompt = captured?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Iron Anchor");
    expect(prompt).toContain(sectionShapeGuide().split("\n")[0]);
  });

  it("passes context and business docs into the prompt when provided", async () => {
    let captured: { messages: { role: string; content: string }[] } | undefined;
    const chat = async (opts: { messages: { role: string; content: string }[] }) => {
      captured = opts;
      return { content: JSON.stringify(GYM_JSON) };
    };
    await generateSite({
      chat,
      model: "capable",
      identity: IDENTITY,
      brand: BRAND,
      pages: [PAGE],
      budgets: new Map(),
      context: CONTEXT,
      business: BUSINESS,
    });
    const prompt = captured?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Strength for real life");
    expect(prompt).toContain("phone only");
  });

  it("throws when the LLM never returns valid JSON", async () => {
    await expect(
      generateSite({
        chat: fakeChat(["not json", "still not json", "nope"]),
        model: "capable",
        identity: IDENTITY,
        brand: BRAND,
        pages: [PAGE],
        budgets: new Map(),
        charCeiling: 10_000,
      }),
    ).rejects.toThrow(/LLM failed to produce valid JSON/);
  });

  it("retries and succeeds when the LLM first returns an invalid section", async () => {
    const bad = {
      ...GYM_JSON,
      hierarchy: {
        pages: [{
          slug: "index",
          title: "Iron Anchor",
          meta: { description: "Strength for real life" },
          sections: [{ section: "hero", content: { wrongField: true } }],
        }],
      },
    };
    const result = await generateSite({
      chat: fakeChat([JSON.stringify(bad), JSON.stringify(GYM_JSON)]),
      model: "capable",
      identity: IDENTITY,
      brand: BRAND,
      pages: [PAGE],
      budgets: new Map(),
      charCeiling: 10_000,
    });
    expect(result.gym.hierarchy.pages[0].sections[0].section).toBe("hero");
  });
});

function pageDoc(slug: string, budget: "full" | "truncated", chars: number): PageDocument {
  return {
    url: `https://g.com/${slug}`, slug, title: slug, metaDescription: "", headings: [],
    bodyText: "y".repeat(chars), images: [], links: [], fetchMethod: "static",
    detectedType: "other", pageArchetype: "other", pageGoal: "inform",
    primaryKeyword: "", secondaryKeywords: [], topicsAnswered: [], conversionSignals: [],
  };
}

describe("budgetPages", () => {
  it("truncates full pages progressively until under the char ceiling", () => {
    const pages = [pageDoc("a", "full", 5000), pageDoc("b", "full", 5000)];
    const budgets = new Map([["a", "full"], ["b", "full"]] as const);
    const out = budgetPages(pages, budgets, 4000);
    expect(out.reduce((n, p) => n + p.bodyText.length, 0)).toBeLessThanOrEqual(4000);
  });

  it("caps full pages at FULL_CHARS even when total is under the ceiling", () => {
    const pages = [pageDoc("a", "full", 50_000)];
    const budgets = new Map([["a", "full"]] as const);
    const out = budgetPages(pages, budgets, 1_000_000);
    expect(out[0].bodyText.length).toBe(8000);
  });

  it("starts truncated pages at 800 chars", () => {
    const pages = [pageDoc("a", "truncated", 5000)];
    const budgets = new Map([["a", "truncated"]] as const);
    const out = budgetPages(pages, budgets, 1_000_000);
    expect(out[0].bodyText.length).toBe(800);
  });
});

describe("sectionShapeGuide", () => {
  it("lists a content-field line for every section type", () => {
    const guide = sectionShapeGuide();
    for (const type of ["hero", "program-cards", "faq", "cta-band"]) {
      expect(guide).toContain(`"${type}"`);
    }
    expect(guide).toMatch(/"hero":\s*\{[^}]*heading/);
  });
});
