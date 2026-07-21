import { z } from "zod";
import { SECTION_TYPES } from "./sections.ts";
import { BrandTokens } from "./brand-tokens.ts";

/**
 * A section INSTANCE on a page: which shared section type, its content, and
 * optional per-instance overrides. Content is validated per-section-type by the
 * renderer against sections.ts; here we enforce the closed vocabulary + shape.
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
  phone: z.string().optional(),
  address: z.string().optional(),
  ogImage: z.string().optional(),
  socialProfiles: z.array(z.string().url()).optional(),
});

export const GymDocuments = z.object({
  identity: Identity,
  brand: BrandTokens,
  hierarchy: SiteHierarchy,
});
export type GymDocuments = z.infer<typeof GymDocuments>;
