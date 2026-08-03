import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalFsAdapter } from "@milo/storage";
import { runLearn } from "../src/learn.ts";
import { FakePlacesClient, FakePageFetcher, fakeChat, fakeChatWithCapture, fakeSocialScraper } from "./fakes.ts";

const fakeFonts = async () => ({ display: "Oswald", body: "Inter" });

const HOME = `<!doctype html><html><head><title>Iron Anchor</title>
<meta name="description" content="Strength for real life"><meta property="og:site_name" content="Iron Anchor">
<style>body{color:#1a1a1a;background:#ffffff}h1{color:#0b1f3a}</style></head>
<body><nav><a href="/about">About</a><a href="/pricing">Pricing</a></nav>
<header><img src="/logo.svg" class="logo" alt="logo"></header>
<main><h1>Welcome to Iron Anchor</h1><p>${"We build strength for regular people. ".repeat(20)}</p><img src="/hero.jpg" alt="gym"></main>
<footer><a href="https://instagram.com/ironanchor">IG</a></footer></body></html>`;

const ABOUT = `<html><head><title>About</title></head><body><main><h1>Our Story</h1><p>${"Founded in 2015. ".repeat(20)}</p></main></body></html>`;
const PRICING = `<html><head><title>Pricing</title></head><body><main><h1>Membership</h1><p>${"Plans from $199/mo. ".repeat(20)}</p></main></body></html>`;

// runLearn makes 3 LLM calls: classifyBusiness (1) + analyzeContext A+B (2, parallel)
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

// Order is load-bearing: runLearn's Promise.all invokes classifyBusiness first (→ BUSINESS),
// then analyzeContext's inner Promise.all invokes A then B (→ CONTEXT, CONTEXT).
// If the outer Promise.all order ever changes, fakeChat will feed the wrong fixture to each schema.
const LEARN_RESPONSES = [JSON.stringify(BUSINESS), JSON.stringify(CONTEXT), JSON.stringify(CONTEXT)];

const IG_PROFILE = {
  platform: "instagram",
  url: "https://instagram.com/ironanchor",
  handle: "ironanchor",
  bio: "Strength for real life. CrossFit, personal training, and community in Denver.",
  profileImage: "https://instagram.com/ironanchor/profile.jpg",
  recentPosts: ["PR day vibes", "New member Monday"],
  postImages: [],
};

let out: string;
beforeEach(async () => { out = await mkdtemp(path.join(tmpdir(), "learn-")); });
afterEach(async () => { await rm(out, { recursive: true, force: true }); });

describe("runLearn", () => {
  it("writes all doc files but NOT gym.json", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat(LEARN_RESPONSES);

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, keyPageLimit: 4, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      socialScraper: fakeSocialScraper([]),
    });

    expect(JSON.parse(await readFile(path.join(out, "identity.json"), "utf8"))).toHaveProperty("found");
    expect(JSON.parse(await readFile(path.join(out, "brand.json"), "utf8"))).toHaveProperty("colors");
    await readFile(path.join(out, "context.json"), "utf8");
    await readFile(path.join(out, "business.json"), "utf8");
    await readFile(path.join(out, "integrations.json"), "utf8");
    expect(await readFile(path.join(out, "context.md"), "utf8")).toMatch(/iron anchor/i);
    expect(await readFile(path.join(out, "business.md"), "utf8")).toMatch(/iron anchor/i);

    // gym.json NOT written — generateSite was never called
    await expect(readFile(path.join(out, "gym.json"), "utf8")).rejects.toThrow();
  });

  it("returns structured data with expected shape", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat(LEARN_RESPONSES);

    const result = await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, keyPageLimit: 4, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      socialScraper: fakeSocialScraper([]),
    });

    expect(result.context).toHaveProperty("brandVoice");
    expect(result.business).toHaveProperty("techStack");
    expect(result.identity).toHaveProperty("found");
    expect(result.brand).toHaveProperty("colors");
    expect(Array.isArray(result.gmbAssets)).toBe(true);
  });

  it("feeds GMB reviews into context + business prompts", async () => {
    const places = new FakePlacesClient({
      displayName: { text: "Iron Anchor" },
      formattedAddress: "1 Dock St, Denver, CO 80202, USA",
      reviews: [
        {
          name: "reviews/1",
          relativePublishTimeDescription: "2 weeks ago",
          rating: 5,
          text: { text: "Best coaching in Denver. The community is incredibly welcoming." },
          authorAttribution: { displayName: "Sam R." },
        },
      ],
    });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME });
    const { chat, prompts } = fakeChatWithCapture(LEARN_RESPONSES);

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, keyPageLimit: 1, concurrency: 1,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      socialScraper: fakeSocialScraper([]),
    });

    // Business prompt includes GMB review highlights
    const businessCall = prompts.find((p) => {
      const user = p.messages.find((m) => m.role === "user")?.content ?? "";
      return typeof user === "string" && user.includes("DETECTED SIGNALS");
    });
    expect(businessCall?.messages.find((m) => m.role === "user")?.content).toContain("Best coaching in Denver");

    // Context prompt includes GMB review highlights
    const contextCall = prompts.find((p) => {
      const user = p.messages.find((m) => m.role === "user")?.content ?? "";
      return typeof user === "string" && user.includes("IDENTITY:");
    });
    expect(contextCall?.messages.find((m) => m.role === "user")?.content).toContain("Best coaching in Denver");
  });

  it("persists operator-supplied websiteUrl and addressParts when Places finds no match", async () => {
    const places = new FakePlacesClient(null);
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME });
    const { chat, prompts } = fakeChatWithCapture(LEARN_RESPONSES);

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, keyPageLimit: 1, concurrency: 1,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      socialScraper: fakeSocialScraper([]),
    });

    const identity = JSON.parse(await readFile(path.join(out, "identity.json"), "utf8"));
    expect(identity.found).toBe(false);
    expect(identity.websiteUrl).toBe("https://ironanchor.com/");
    expect(identity.addressParts).toEqual({ city: "Denver", state: "CO", country: "US" });

    // Business signals block is null when no GMB match
    const businessCall = prompts.find((p) => {
      const user = p.messages.find((m) => m.role === "user")?.content ?? "";
      return typeof user === "string" && user.includes("DETECTED SIGNALS");
    });
    const businessUser = businessCall?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(businessUser).toContain('"gmb":null');
  });

  it("appends scraped social profile text to the homepage body text in context", async () => {
    const places = new FakePlacesClient(null);
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME });
    const social = fakeSocialScraper([IG_PROFILE]);
    const { chat, prompts } = fakeChatWithCapture(LEARN_RESPONSES);

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, keyPageLimit: 1, concurrency: 1,
      places, fetcher, socialScraper: social, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
    });

    // Context prompt should include social profile text (enriched homepage body)
    const contextCall = prompts.find((p) => {
      const user = p.messages.find((m) => m.role === "user")?.content ?? "";
      return typeof user === "string" && user.includes("IDENTITY:");
    });
    const contextUser = contextCall?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(contextUser).toContain(IG_PROFILE.bio);
  });
});

describe("runLearn storage mode", () => {
  it("writes docs to gyms/<slug>/docs/ via an injected storage adapter", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat(LEARN_RESPONSES);
    const storage = new LocalFsAdapter(path.join(out, "storage"));

    const result = await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      slug: "ironanchor-com",
      storage,
      keyPageLimit: 4, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      socialScraper: fakeSocialScraper([]),
    });

    const docsRoot = path.join(out, "storage", "gyms", "ironanchor-com", "docs");
    expect(JSON.parse(await readFile(path.join(docsRoot, "identity.json"), "utf8"))).toHaveProperty("found");
    expect(JSON.parse(await readFile(path.join(docsRoot, "brand.json"), "utf8"))).toHaveProperty("colors");
    expect(JSON.parse(await readFile(path.join(docsRoot, "context.json"), "utf8"))).toBeTruthy();
    expect(JSON.parse(await readFile(path.join(docsRoot, "business.json"), "utf8"))).toBeTruthy();
    expect(await readFile(path.join(docsRoot, "context.md"), "utf8")).toMatch(/iron anchor/i);
    expect(await readFile(path.join(docsRoot, "business.md"), "utf8")).toMatch(/iron anchor/i);
    expect(result.docsUri).toContain("gyms/ironanchor-com/docs");
    await expect(readFile(path.join(docsRoot, "gym.json"), "utf8")).rejects.toThrow();
  });

  it("emits verbose events to the injected logger", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat(LEARN_RESPONSES);
    const verboseMsgs: string[] = [];
    const logger = { info: () => {}, warn: () => {}, verbose: (m: string) => verboseMsgs.push(m) };

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out,
      logger,
      keyPageLimit: 4, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      socialScraper: fakeSocialScraper([]),
    });

    expect(verboseMsgs.some((m) => m.includes("fetched"))).toBe(true);
  });
});
