import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GymDocuments } from "@milo/schema";
import { runIntake } from "../src/intake.ts";
import { FakePlacesClient, FakePageFetcher, fakeChat } from "./fakes.ts";

const HOME = `<!doctype html><html><head><title>Iron Anchor</title>
<meta name="description" content="Strength for real life"><meta property="og:site_name" content="Iron Anchor">
<style>body{color:#1a1a1a;background:#ffffff}h1{color:#0b1f3a}</style></head>
<body><nav><a href="/about">About</a><a href="/pricing">Pricing</a></nav>
<header><img src="/logo.svg" class="logo" alt="logo"></header>
<main><h1>Welcome to Iron Anchor</h1><p>${"We build strength for regular people. ".repeat(20)}</p><img src="/hero.jpg" alt="gym"></main>
<footer><a href="https://instagram.com/ironanchor">IG</a></footer></body></html>`;

const ABOUT = `<html><head><title>About</title></head><body><main><h1>Our Story</h1><p>${"Founded in 2015. ".repeat(20)}</p></main></body></html>`;
const PRICING = `<html><head><title>Pricing</title></head><body><main><h1>Membership</h1><p>${"Plans from $199/mo. ".repeat(20)}</p></main></body></html>`;

// LLM responses in call order: 3 page classifications, then gym, context, business
const GYM = {
  identity: { name: "Iron Anchor", tagline: "Strength for real life" },
  brand: { colors: { primary: "#0b1f3a", accent: "#e63946", surface: "#ffffff", text: "#1a1a1a", muted: "#8a8a8a" },
    fonts: { display: "Oswald", body: "Inter" }, space: { sm: "8px", md: "16px", lg: "32px" }, radius: { button: "6px", card: "12px" } },
  hierarchy: { pages: [{ slug: "index", title: "Home", meta: { description: "d" }, sections: [{ section: "hero", content: { heading: "Welcome", image: { src: "/assets/hero.jpg", alt: "gym" } } }] }] },
};
const CONTEXT = {
  icp: { fitnessLevel: "beginner-friendly", ageRange: "25-45", lifestage: [], primaryGoals: [], psychographics: "" },
  brandVoice: { tone: "direct", avoids: [], emphasizes: [], communicationStyle: "you" },
  positioning: { headline: "h", differentiators: [], vsCompetition: "", competitivePositioning: "" },
  painPointsAddressed: [], primaryOffer: "Free intro", pricingTier: "mid-market", memberTransformationLanguage: [],
  commonObjections: [], contentPillars: [], coachAuthoritySignals: [],
  socialProof: { yearsOpen: null, memberCount: null, mediaAchievements: [], reviewHighlights: [] },
  geographicContext: { neighborhood: "", city: "Denver", localCultureSignals: [], areaServed: [] },
  seasonalCampaigns: [], siteArchitecture: [],
};
const BUSINESS = {
  techStack: { websiteBuilder: null, gymSoftware: null, emailPlatform: null, bookingMethod: "phone only", hasPaymentProcessing: false, hasLiveChat: false },
  marketingMaturity: { runsPaidAds: false, hasEmailList: false, doesContentMarketing: false, hasMemberApp: false, socialPlatforms: ["instagram"] },
  businessSignals: { locationCount: 1, coachCount: null, pricingPoints: [], membershipModel: [], hasCompetitiveTeam: false },
  assessment: "ok",
};
const CLASS = JSON.stringify({ detectedType: "other", pageArchetype: "other", pageGoal: "inform", primaryKeyword: "", secondaryKeywords: [], topicsAnswered: [], conversionSignals: [] });

let out: string;
beforeEach(async () => { out = await mkdtemp(path.join(tmpdir(), "intake-")); });
afterEach(async () => { await rm(out, { recursive: true, force: true }); });

describe("runIntake", () => {
  it("produces all four validated output files + crawl bundle offline", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    // classify calls: 3 pages -> 3 CLASS, then business, context, gym
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT), JSON.stringify(GYM)]);

    await runIntake({
      url: "https://ironanchor.com", outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
    });

    const gym = JSON.parse(await readFile(path.join(out, "gym.json"), "utf8"));
    expect(() => GymDocuments.parse(gym)).not.toThrow();
    const integrations = JSON.parse(await readFile(path.join(out, "integrations.json"), "utf8"));
    expect(integrations.analytics.ga4.detected).toBe(false);
    await readFile(path.join(out, "context.json"), "utf8");
    await readFile(path.join(out, "business.json"), "utf8");
    await readFile(path.join(out, "crawl/pages.json"), "utf8");
    // Full internal link map is written, with every crawled page as a node.
    const links = JSON.parse(await readFile(path.join(out, "crawl/links.json"), "utf8"));
    expect(links.nodes.map((n: { slug: string }) => n.slug).sort()).toEqual(["about", "index", "pricing"]);
    expect(links.nodes.every((n: { crawled: boolean }) => n.crawled)).toBe(true);
  });

  it("fails fast when --skip-crawl but no crawl bundle exists", async () => {
    const places = new FakePlacesClient(null);
    const fetcher = new FakePageFetcher({});
    await expect(runIntake({
      url: "https://ironanchor.com", outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat: fakeChat([]), capableModel: "c", fastModel: "f", skipCrawl: true,
      discoveredAt: "t",
    })).rejects.toThrow(/No crawl bundle found/);
  });

  it("skips a page whose fetch throws, still completes and writes gym.json", async () => {
    const places = new FakePlacesClient(null);
    // /pricing throws (HTTP 500). Homepage + /about still crawl.
    const fetcher = new FakePageFetcher(
      { "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING },
      ["/pricing"],
    );
    // Only 2 pages successfully crawl -> 2 CLASS calls, then business, context, gym.
    const chat = fakeChat([CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT), JSON.stringify(GYM)]);

    await runIntake({
      url: "https://ironanchor.com", outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
    });

    // Run completes and produces the primary output.
    const gym = JSON.parse(await readFile(path.join(out, "gym.json"), "utf8"));
    expect(() => GymDocuments.parse(gym)).not.toThrow();

    // The failed page never becomes a crawled node in the link map.
    const links = JSON.parse(await readFile(path.join(out, "crawl/links.json"), "utf8"));
    const pricingNode = links.nodes.find((n: { slug: string }) => n.slug === "pricing");
    // It may appear as a mapped-only node (linked from home) but must NOT be crawled.
    if (pricingNode) expect(pricingNode.crawled).toBe(false);
    const crawledSlugs = links.nodes.filter((n: { crawled: boolean }) => n.crawled).map((n: { slug: string }) => n.slug).sort();
    expect(crawledSlugs).toEqual(["about", "index"]);
  });
});
