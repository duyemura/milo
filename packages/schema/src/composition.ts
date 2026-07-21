import { z } from "zod";
import { SECTION_TYPES } from "./sections.ts";
import { BrandTokens } from "./brand-tokens.ts";

/**
 * A section INSTANCE on a page: which shared section type, its content, and
 * optional per-instance overrides. Content is spread as component props by the
 * renderer. The renderer validates content against sections.ts (Section.safeParse)
 * before rendering.
 */
export const SectionInstance = z.object({
  section: z.enum(SECTION_TYPES),
  content: z.record(z.string(), z.unknown()),
  overrides: z.record(z.string(), z.unknown()).optional(),
});
export type SectionInstance = z.infer<typeof SectionInstance>;

export const Page = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  meta: z.object({ description: z.string().min(1) }),
  sections: z.array(SectionInstance).min(1),
});
export type Page = z.infer<typeof Page>;

export const SiteHierarchy = z.object({ pages: z.array(Page).min(1) });

export const Identity = z.object({
  name: z.string().min(1),
  tagline: z.string().min(1),
  siteUrl: z.string().url().optional(),
  // Contact / NAP
  phone: z.string().optional(),
  address: z.string().optional(),          // flat fallback string
  addressParts: z.object({                 // structured — preferred for JSON-LD
    street: z.string().min(1),
    city: z.string().min(1),
    state: z.string().min(1),
    zip: z.string().min(1),
    country: z.string().default("US"),
  }).optional(),
  // Maps / local SEO
  geoCoordinates: z.object({
    lat: z.number(),
    lng: z.number(),
  }).optional(),
  mapsUrl: z.string().url().optional(),               // hasMap
  googleBusinessProfileUrl: z.string().url().optional(), // sameAs
  priceRange: z.string().optional(),                  // e.g. "$$"
  // Media / brand
  ogImage: z.string().optional(),
  favicon: z.string().optional(),
  themeColor: z.string().optional(),                  // hex, e.g. "#0b1f3a"
  // Social
  socialProfiles: z.array(z.string().url()).optional(),
});

export const GymDocuments = z.object({
  identity: Identity,
  brand: BrandTokens,
  hierarchy: SiteHierarchy,
});
export type GymDocuments = z.infer<typeof GymDocuments>;
