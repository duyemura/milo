import { z } from "zod";

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
 * anywhere in the crawl, whether or not it was fetched.
 */
export const LinkMap = z.object({
  baseUrl: z.string().url(),
  discoveredAt: z.string(),
  nodes: z.array(z.object({
    url: z.string().url(),
    slug: z.string().min(1),
    crawled: z.boolean(),
    isUgc: z.boolean(),
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

/** crawl/brand.json — raw brand signals before classification into BrandTokens. */
export const BrandCrawl = z.object({
  colors: z.record(z.string(), z.number()),
  fonts: z.record(z.string(), z.string()),
  logo: z.string().nullable(),
  socialLinks: z.array(z.string()),
  software: z.string().nullable(),
  analytics: z.record(z.string(), z.string()),
  fontFiles: z.array(z.string()).default([]),
});
export type BrandCrawl = z.infer<typeof BrandCrawl>;
