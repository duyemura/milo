import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GymDocuments } from "@milo/schema";
import { LocalFsAdapter } from "@milo/storage";
import { runIntake, runLearn } from "../src/intake.ts";
import { FakePlacesClient, FakePageFetcher, fakeChat, fakeChatWithCapture, fakeSocialScraper } from "./fakes.ts";
import { sanitizeAssetName } from "../src/crawl.ts";

const fakeFonts = async () => ({ display: "Oswald", body: "Inter" });
const fakeDownload = async (url: string, _dir: string, preferredName?: string) => `/assets/${preferredName ?? sanitizeAssetName(url)}`;

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

const IG_PROFILE = {
  platform: "instagram",
  url: "https://instagram.com/ironanchor",
  handle: "ironanchor",
  bio: "Strength for real life. CrossFit, personal training, and community in Denver.",
  profileImage: "https://instagram.com/ironanchor/profile.jpg",
  recentPosts: ["PR day vibes", "New member Monday"],
};

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
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US", outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    const gym = JSON.parse(await readFile(path.join(out, "gym.json"), "utf8"));
    expect(() => GymDocuments.parse(gym)).not.toThrow();
    const integrations = JSON.parse(await readFile(path.join(out, "integrations.json"), "utf8"));
    expect(integrations.analytics.ga4.detected).toBe(false);
    await readFile(path.join(out, "context.json"), "utf8");
    await readFile(path.join(out, "business.json"), "utf8");
    await readFile(path.join(out, "crawl/pages.json"), "utf8");
    // Downloaded assets get a localPath; src stays the original URL.
    const indexDoc = JSON.parse(await readFile(path.join(out, "crawl/pages/index.json"), "utf8"));
    const heroImg = indexDoc.images.find((i: { src: string }) => i.src.includes("hero.jpg"));
    expect(heroImg.localPath).toMatch(/^\/assets\//);
    expect(heroImg.src).toMatch(/^https:\/\/ironanchor\.com\/hero\.jpg$/);
    // Full internal link map is written, with every crawled page as a node.
    const links = JSON.parse(await readFile(path.join(out, "crawl/links.json"), "utf8"));
    expect(links.nodes.map((n: { slug: string }) => n.slug).sort()).toEqual(["about", "index", "pricing"]);
    expect(links.nodes.every((n: { crawled: boolean }) => n.crawled)).toBe(true);
  });

  it("fails fast when --skip-crawl but no crawl bundle exists", async () => {
    const places = new FakePlacesClient(null);
    const fetcher = new FakePageFetcher({});
    await expect(runIntake({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US", outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
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
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US", outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
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

  it("homepage-only intake still produces a valid gym.json and tells the generator to create placeholders", async () => {
    const places = new FakePlacesClient(null);
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME });
    const { chat, prompts } = fakeChatWithCapture([
      CLASS,
      JSON.stringify(BUSINESS),
      JSON.stringify(CONTEXT),
      JSON.stringify(GYM),
    ]);

    await runIntake({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US", outDir: out, maxPages: 1, includeUgc: false, concurrency: 1,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    const gym = JSON.parse(await readFile(path.join(out, "gym.json"), "utf8"));
    expect(() => GymDocuments.parse(gym)).not.toThrow();

    // 4 LLM calls: classify home, business, context, generate.
    expect(prompts.length).toBe(4);
    const generatePrompt = prompts[prompts.length - 1].messages;
    const systemContent = generatePrompt.find((m) => m.role === "system")?.content ?? "";
    expect(systemContent).toContain("PLACEHOLDER ARCHETYPES");
    for (const archetype of ["about", "coaches", "programs", "pricing", "contact"]) {
      expect(systemContent).toContain(archetype);
    }
  });

  it("downloads GMB photos and feeds review text into context + business prompts", async () => {
    const places = new FakePlacesClient({
      displayName: { text: "Iron Anchor" },
      formattedAddress: "1 Dock St, Denver, CO 80202, USA",
      photos: [
        { name: "places/ChIJfake/photos/1", widthPx: 1200, heightPx: 800, authorAttributions: [{ displayName: "Sam R.", uri: "https://maps.google.com/sam" }] },
        { name: "places/ChIJfake/photos/2", widthPx: 600, heightPx: 400 },
      ],
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
    const { chat, prompts } = fakeChatWithCapture([
      CLASS,
      JSON.stringify(BUSINESS),
      JSON.stringify(CONTEXT),
      JSON.stringify(GYM),
    ]);

    await runIntake({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, maxPages: 1, includeUgc: false, concurrency: 1,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });


    // GMB assets manifest lists both photos but the fake client always resolves URIs,
    // and fakeDownload always succeeds.
    const gmbAssets = JSON.parse(await readFile(path.join(out, "crawl/gmb-assets.json"), "utf8"));
    expect(gmbAssets.count).toBe(2);
    expect(gmbAssets.assets[0].localPath).toMatch(/^\/assets\/gmb-/);

    // Context prompt includes GMB review highlights.
    const contextPrompt = prompts.find((p) => p.model === "capable")?.messages ?? [];
    const contextUser = contextPrompt.find((m) => m.role === "user")?.content ?? "";
    expect(contextUser).toContain("GMB CONTEXT");
    expect(contextUser).toContain("Best coaching in Denver");

    // Business prompt includes GMB review highlights (look at the second fast call, not classifyPage).
    const businessPrompts = prompts.filter((p) => p.model === "fast");
    const businessCall = businessPrompts[1]; // first fast call is classifyPage, second is classifyBusiness
    const businessUser = businessCall?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(businessUser).toContain("DETECTED SIGNALS");
    expect(businessUser).toContain("Best coaching in Denver");

    // Context prompt carries GMB image metadata (width/height/attribution), not just a count.
    expect(contextUser).toContain('"widthPx":1200');
    expect(contextUser).toContain('"heightPx":800');
    expect(contextUser).toContain('"attribution":"Sam R."');
  });

  it("persists operator-supplied websiteUrl and addressParts when Places finds no match", async () => {
    const places = new FakePlacesClient(null);
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME });
    const { chat, prompts } = fakeChatWithCapture([
      CLASS,
      JSON.stringify(BUSINESS),
      JSON.stringify(CONTEXT),
      JSON.stringify(GYM),
    ]);

    await runIntake({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, maxPages: 1, includeUgc: false, concurrency: 1,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    const identity = JSON.parse(await readFile(path.join(out, "crawl/identity.json"), "utf8"));
    expect(identity.found).toBe(false);
    expect(identity.websiteUrl).toBe("https://ironanchor.com/");
    expect(identity.addressParts).toEqual({ city: "Denver", state: "CO", country: "US" });

    // Business signals block is null when no GMB match, not an empty object.
    const businessPrompts = prompts.filter((p) => p.model === "fast");
    const businessCall = businessPrompts[1];
    const businessUser = businessCall?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(businessUser).toContain('"gmb":null');
  });

  it("appends scraped social profile text to the homepage body", async () => {
    const places = new FakePlacesClient(null);
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME });
    const social = fakeSocialScraper([IG_PROFILE]);
    const chat = fakeChat([
      CLASS,
      JSON.stringify(BUSINESS),
      JSON.stringify(CONTEXT),
      JSON.stringify(GYM),
    ]);

    await runIntake({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US", outDir: out, maxPages: 1, includeUgc: false, concurrency: 1,
      places, fetcher, socialScraper: social, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
    });

    const indexDoc = JSON.parse(await readFile(path.join(out, "crawl/pages/index.json"), "utf8"));
    expect(indexDoc.bodyText).toContain("--- Social profiles ---");
    expect(indexDoc.bodyText).toContain(IG_PROFILE.bio);
    expect(indexDoc.bodyText).toContain(IG_PROFILE.recentPosts[0]);
  });
});

describe("runLearn", () => {
  it("writes crawl bundle + context.json + business.json but NOT gym.json", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    // 3 page classifications + BUSINESS + CONTEXT (no GYM call)
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    // crawl bundle written
    const crawlDir = path.join(out, "crawl");
    expect(JSON.parse(await readFile(path.join(crawlDir, "identity.json"), "utf8"))).toHaveProperty("found");
    expect(JSON.parse(await readFile(path.join(crawlDir, "brand.json"), "utf8"))).toHaveProperty("colors");
    expect(JSON.parse(await readFile(path.join(crawlDir, "pages.json"), "utf8"))).toHaveProperty("pages");

    // LLM doc outputs written
    expect(await readFile(path.join(out, "context.json"), "utf8")).toBeTruthy();
    expect(await readFile(path.join(out, "business.json"), "utf8")).toBeTruthy();

    // Markdown docs written
    expect(await readFile(path.join(out, "context.md"), "utf8")).toMatch(/iron anchor/i);
    expect(await readFile(path.join(out, "business.md"), "utf8")).toMatch(/iron anchor/i);

    // gym.json NOT written — generateSite was never called
    await expect(readFile(path.join(out, "gym.json"), "utf8")).rejects.toThrow();
  });

  it("returns structured data usable by generateSite", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);

    const result = await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out, maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    expect(result.context).toHaveProperty("brandVoice");
    expect(result.business).toHaveProperty("techStack");
    expect(result.identity).toHaveProperty("found");
    expect(result.pageDocs.length).toBeGreaterThan(0);
    expect(result.brand).toHaveProperty("colors");
  });
});

describe("runLearn storage mode", () => {
  it("writes docs to gyms/<slug>/docs/ via an injected storage adapter", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);
    const storage = new LocalFsAdapter(path.join(out, "storage"));
    // Unlike fakeDownload (path-only), this fake writes real bytes so the tmp-staging
    // → storage putFile upload path is exercised.
    const downloadAndWrite = async (_url: string, assetsDir: string, preferredName?: string) => {
      const name = preferredName ?? "asset-1.jpg";
      await writeFile(path.join(assetsDir, name), Buffer.from("fake-bytes"));
      return `/assets/${name}`;
    };

    const result = await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      slug: "ironanchor-com",
      storage,
      maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: downloadAndWrite,
      socialScraper: fakeSocialScraper([]),
    });

    const docsRoot = path.join(out, "storage", "gyms", "ironanchor-com", "docs");
    // Binary assets uploaded through the storage seam, not just JSON docs
    expect(await readFile(path.join(docsRoot, "assets", "asset-1.jpg"), "utf8")).toBe("fake-bytes");
    // Canonical top-level copies
    expect(JSON.parse(await readFile(path.join(docsRoot, "brand.json"), "utf8"))).toHaveProperty("colors");
    expect(JSON.parse(await readFile(path.join(docsRoot, "pages.json"), "utf8"))).toHaveProperty("pages");
    // Deprecated crawl/ duplicates (kept for the generate path)
    expect(JSON.parse(await readFile(path.join(docsRoot, "crawl", "brand.json"), "utf8"))).toHaveProperty("colors");
    expect(JSON.parse(await readFile(path.join(docsRoot, "crawl", "pages.json"), "utf8"))).toHaveProperty("pages");
    // Crawl bundle + markdown + structured docs
    expect(JSON.parse(await readFile(path.join(docsRoot, "crawl", "identity.json"), "utf8"))).toHaveProperty("found");
    expect(await readFile(path.join(docsRoot, "context.md"), "utf8")).toMatch(/iron anchor/i);
    expect(await readFile(path.join(docsRoot, "business.md"), "utf8")).toMatch(/iron anchor/i);
    expect(JSON.parse(await readFile(path.join(docsRoot, "context.json"), "utf8"))).toBeTruthy();
    // docsUri reported on the result; gym.json NOT written by runLearn
    expect(result.docsUri).toContain("gyms/ironanchor-com/docs");
    await expect(readFile(path.join(docsRoot, "gym.json"), "utf8")).rejects.toThrow();
  });

  it("emits verbose events to the injected logger", async () => {
    const places = new FakePlacesClient({ displayName: { text: "Iron Anchor" }, formattedAddress: "1 Dock St, Denver, CO 80202, USA" });
    const fetcher = new FakePageFetcher({ "https://ironanchor.com/": HOME, "/about": ABOUT, "/pricing": PRICING });
    const chat = fakeChat([CLASS, CLASS, CLASS, JSON.stringify(BUSINESS), JSON.stringify(CONTEXT)]);
    const verboseMsgs: string[] = [];
    const logger = { info: () => {}, warn: () => {}, verbose: (m: string) => verboseMsgs.push(m) };

    await runLearn({
      url: "https://ironanchor.com", gymName: "Iron Anchor", city: "Denver", state: "CO", country: "US",
      outDir: out,
      logger,
      maxPages: 25, includeUgc: false, concurrency: 3,
      places, fetcher, chat, capableModel: "capable", fastModel: "fast",
      normalizeFetch: async () => ({ url: "https://ironanchor.com/" }) as unknown as Response,
      discoveredAt: "2026-07-28T00:00:00Z",
      captureFonts: fakeFonts,
      downloadOne: fakeDownload,
      socialScraper: fakeSocialScraper([]),
    });

    expect(verboseMsgs.some((m) => m.includes("crawled"))).toBe(true);
    expect(verboseMsgs.some((m) => m.includes("classified"))).toBe(true);
  });
});
