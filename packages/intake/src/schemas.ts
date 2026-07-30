import { z } from "zod";

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
    emailPlatform: z.string().nullable(), bookingMethod: z.string().nullable(),
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
