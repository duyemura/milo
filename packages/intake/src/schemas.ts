import { z } from "zod";

// ---------- Internal crawl artifacts ----------

/** crawl/pages.json — the discovery inventory. */
export const PagesJson = z.object({
  baseUrl: z.string().url(),
  discoveredAt: z.string(),
  totalDiscovered: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative().default(0),
  capped: z.number().int().nonnegative().default(0),
  pages: z.array(
    z.object({
      url: z.string().url(),
      slug: z.string().min(1),
      priority: z.number().int().min(1).max(9),
      source: z.enum(["sitemap", "nav", "crawl-discovered"]),
      llmBudget: z.enum(["full", "truncated"]),
    }),
  ),
});
export type PagesJson = z.infer<typeof PagesJson>;
export type PageInventoryItem = PagesJson["pages"][number];

/**
 * crawl/links.json — the FULL internal link graph. Every same-origin URL seen
 * anywhere in the crawl, whether or not it was fetched. This is our own map of
 * the gym's real site structure, independent of the --max-pages cap.
 */
export const LinkMap = z.object({
  baseUrl: z.string().url(),
  discoveredAt: z.string(),
  nodes: z.array(z.object({
    url: z.string().url(),
    slug: z.string().min(1),
    crawled: z.boolean(),          // did we fetch + produce a PageDocument for it?
    isUgc: z.boolean(),            // matched the UGC filter (blog/news/date/etc.)
  })),
  edges: z.array(z.object({ from: z.string().url(), to: z.string().url() })),
});
export type LinkMap = z.infer<typeof LinkMap>;

/** crawl/pages/{slug}.json — one crawled page. */
export const PageDocument = z.object({
  url: z.string().url(),
  slug: z.string().min(1),
  title: z.string().default(""),
  metaDescription: z.string().default(""),
  headings: z.array(z.string()).default([]),
  bodyText: z.string().default(""),
  images: z.array(
    z.object({ src: z.string(), alt: z.string().default(""), localPath: z.string().nullable().default(null) }),
  ).default([]),
  links: z.array(z.string()).default([]),
  fetchMethod: z.enum(["static", "playwright"]),
  detectedType: z.string().default("other"),
  pageArchetype: z.string().default("other"),
  pageGoal: z.string().default("inform"),
  primaryKeyword: z.string().default(""),
  secondaryKeywords: z.array(z.string()).default([]),
  topicsAnswered: z.array(z.string()).default([]),
  conversionSignals: z.array(z.string()).default([]),
});
export type PageDocument = z.infer<typeof PageDocument>;

/** crawl/identity.json — raw Places result normalized. `found:false` when no match. */
export const IdentityCrawl = z.object({
  found: z.boolean(),
  name: z.string().optional(),
  formattedAddress: z.string().optional(),
  addressParts: z.object({
    street: z.string(), city: z.string(), state: z.string(), zip: z.string(), country: z.string().default("US"),
  }).partial().optional(),
  phone: z.string().optional(),
  geoCoordinates: z.object({ lat: z.number(), lng: z.number() }).optional(),
  mapsUrl: z.string().optional(),
  googleBusinessProfileUrl: z.string().optional(),
  priceLevel: z.string().optional(),
  rating: z.number().optional(),
  reviewCount: z.number().optional(),
  openingHoursSpecification: z.array(z.object({
    dayOfWeek: z.array(z.string()).min(1), opens: z.string(), closes: z.string(),
  })).optional(),
});
export type IdentityCrawl = z.infer<typeof IdentityCrawl>;

/** crawl/brand.json — raw brand signals before LLM classification into BrandTokens. */
export const BrandCrawl = z.object({
  colors: z.record(z.string(), z.number()),          // hex -> frequency
  fonts: z.record(z.string(), z.string()),           // slot -> family ("display"/"body"/raw)
  logo: z.string().nullable(),
  socialLinks: z.array(z.string()),
  software: z.string().nullable(),                   // detected gym-software platform
  analytics: z.record(z.string(), z.string()),       // detector -> id
  fontFiles: z.array(z.string()).default([]),        // downloadable @font-face URLs
});
export type BrandCrawl = z.infer<typeof BrandCrawl>;

// ---------- Output docs (LLM-produced, operator-editable) ----------

export const ContextDoc = z.object({
  icp: z.object({
    fitnessLevel: z.string(), ageRange: z.string(), lifestage: z.array(z.string()),
    primaryGoals: z.array(z.string()), psychographics: z.string(),
  }),
  brandVoice: z.object({
    tone: z.string(), avoids: z.array(z.string()), emphasizes: z.array(z.string()), communicationStyle: z.string(),
  }),
  positioning: z.object({
    headline: z.string(), differentiators: z.array(z.string()),
    vsCompetition: z.string(), competitivePositioning: z.string(),
  }),
  painPointsAddressed: z.array(z.string()),
  primaryOffer: z.string(),
  pricingTier: z.string(),
  memberTransformationLanguage: z.array(z.string()),
  commonObjections: z.array(z.string()),
  contentPillars: z.array(z.string()),
  coachAuthoritySignals: z.array(z.string()),
  socialProof: z.object({
    yearsOpen: z.number().nullable(), memberCount: z.string().nullable(),
    mediaAchievements: z.array(z.string()), reviewHighlights: z.array(z.string()),
  }),
  geographicContext: z.object({
    neighborhood: z.string(), city: z.string(),
    localCultureSignals: z.array(z.string()), areaServed: z.array(z.string()),
  }),
  seasonalCampaigns: z.array(z.string()),
  siteArchitecture: z.array(z.object({ slug: z.string(), archetype: z.string(), goal: z.string() })),
});
export type ContextDoc = z.infer<typeof ContextDoc>;

export const BusinessDoc = z.object({
  techStack: z.object({
    websiteBuilder: z.string().nullable(), gymSoftware: z.string().nullable(),
    emailPlatform: z.string().nullable(), bookingMethod: z.string(),
    hasPaymentProcessing: z.boolean(), hasLiveChat: z.boolean(),
  }),
  marketingMaturity: z.object({
    runsPaidAds: z.boolean(), hasEmailList: z.boolean(), doesContentMarketing: z.boolean(),
    hasMemberApp: z.boolean(), socialPlatforms: z.array(z.string()),
  }),
  businessSignals: z.object({
    locationCount: z.number(), coachCount: z.number().nullable(),
    pricingPoints: z.array(z.string()), membershipModel: z.array(z.string()),
    hasCompetitiveTeam: z.boolean(),
  }),
  assessment: z.string(),
});
export type BusinessDoc = z.infer<typeof BusinessDoc>;

export const IntegrationsDoc = z.object({
  analytics: z.object({
    ga4: z.object({ measurementId: z.string().nullable().default(null), detected: z.boolean().default(false) }),
    gtm: z.object({ containerId: z.string().nullable().default(null), detected: z.boolean().default(false) }),
    facebookPixel: z.object({ pixelId: z.string().nullable().default(null), detected: z.boolean().default(false) }),
    hotjar: z.object({ siteId: z.string().nullable().default(null), detected: z.boolean().default(false) }),
  }).default({ ga4: {}, gtm: {}, facebookPixel: {}, hotjar: {} } as never),
  gymSoftware: z.object({
    platform: z.string().nullable().default(null), detected: z.boolean().default(false),
    bookingUrl: z.string().nullable().default(null),
  }).default({} as never),
  email: z.object({
    platform: z.string().nullable().default(null), detected: z.boolean().default(false),
    embedCode: z.string().nullable().default(null),
  }).default({} as never),
  chat: z.object({
    platform: z.string().nullable().default(null), detected: z.boolean().default(false),
  }).default({} as never),
});
export type IntegrationsDoc = z.infer<typeof IntegrationsDoc>;
