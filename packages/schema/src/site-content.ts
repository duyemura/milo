import { z } from "zod";
import { Section } from "./sections.ts";

/** Page archetypes — closed list per the spec. SEO treatment hangs off these. */
export const PAGE_ARCHETYPES = [
  "home",
  "about",
  "coaches",
  "programs-index",
  "program-detail",
  "schedule",
  "pricing",
  "location-contact",
  "drop-in",
  "getting-started",
  "landing-page",
  "pillar-page",
  "blog-index",
  "blog-post",
  "testimonials",
] as const;

const Link = z.object({ label: z.string().min(1), href: z.string().min(1) });

export const Brand = z.object({
  name: z.string().min(1),
  tagline: z.string().optional(),
  logoUrl: z.string().optional(),
  colors: z
    .object({
      accent: z.string().default("#0464fc"),
      dark: z.string().default("#000b27"),
    })
    .default({}),
});

export const Business = z.object({
  category: z.string().default("gym"),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  hours: z.array(z.string()).default([]),
  socials: z
    .object({
      twitter: z.string().optional(),
      instagram: z.string().optional(),
      facebook: z.string().optional(),
      youtube: z.string().optional(),
    })
    .default({}),
});

export const NavConfig = z.object({
  programs: z.array(Link).default([]),
  links: z.array(Link).min(1),
  cta: Link,
});

export const FooterConfig = z.object({
  tagline: z.string().optional(),
  groups: z.array(z.object({ label: z.string().min(1), links: z.array(Link).min(1) })).default([]),
  address: z.string().optional(),
  hours: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
});

export const Page = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
  archetype: z.enum(PAGE_ARCHETYPES),
  seo: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
  }),
  sections: z.array(Section).min(1),
});

export const GymSiteContent = z
  .object({
    schemaVersion: z.literal(1),
    brand: Brand,
    business: Business,
    nav: NavConfig,
    footer: FooterConfig,
    pages: z.array(Page).min(1),
  })
  .refine((c) => c.pages.filter((p) => p.slug === "home").length === 1, {
    message: "content must contain exactly one page with slug \"home\"",
  });

export type GymSiteContent = z.infer<typeof GymSiteContent>;
export type Page = z.infer<typeof Page>;
