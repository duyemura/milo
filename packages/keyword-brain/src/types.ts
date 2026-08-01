import { z } from "zod";

/** Gym context the brain reasons over (assembled by the caller). */
export const GymContextSchema = z.object({
  siteId: z.string(),
  companyId: z.string(),
  companyName: z.string(),
  sourceUrl: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  activities: z.array(z.string()),
  differentiators: z.array(z.string()).default([]),
});
export type GymContext = z.infer<typeof GymContextSchema>;

export const IntentSchema = z.enum(["transactional", "informational"]);
export type Intent = z.infer<typeof IntentSchema>;

/** THE HANDSHAKE — what the site builder consumes to build pages. */
export const PageBriefSchema = z.object({
  siteId: z.string(),
  companyId: z.string(),

  keywordCluster: z.string(),
  primaryKeyword: z.string(),
  secondaryKeywords: z.array(z.string()).default([]),
  intent: IntentSchema,
  suggestedUrl: z.string(),
  pageType: z.string().default("local-landing"),
  /** What the page must measurably achieve for the gym. */
  goal: z.string(),
  /** Ordered section plan: role + content notes (NOT layouts — builder owns those). */
  outline: z.array(z.object({ role: z.string(), notes: z.string() })),
  differentiators: z.array(z.string()).default([]),
  localSignals: z.array(z.string()).default([]),

  status: z.enum(["pending", "accepted", "built", "dismissed"]).default("pending"),
});
export type PageBrief = z.infer<typeof PageBriefSchema>;

export const KeywordClusterSchema = z.object({
  cluster: z.string(),
  primaryKeyword: z.string(),
  intent: IntentSchema,
  fit: z.number().min(0).max(1),
  effort: z.enum(["low", "medium", "high"]),
  novelty: z.number().min(0).max(1),
  suggestions: z.array(z.string()),
});
export type KeywordCluster = z.infer<typeof KeywordClusterSchema>;

export const BriefRunResultSchema = z.object({
  clusters: z.array(KeywordClusterSchema),
  briefs: z.array(PageBriefSchema),
  digest: z.string(),
});
export type BriefRunResult = z.infer<typeof BriefRunResultSchema>;

/** Injected autocomplete fetcher (real HTTP by default; scripts in tests). */
export type SuggestFn = (seedQuery: string) => Promise<string[]>;
