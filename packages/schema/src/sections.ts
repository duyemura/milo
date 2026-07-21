import { z } from "zod";

/**
 * The closed section-component vocabulary. Every template implements all of
 * these; the renderer refuses anything outside this union. Spec:
 * docs/specs/2026-07-19-milo-v2-rethink-design.md
 */

// Plain URL string — used only inside LogoStrip which already wraps it in {src, alt}
const imageUrl = z.string().min(1);

// Rich image with alt text for standalone image props (SEO + a11y)
export const SectionImage = z.object({
  src: z.string().min(1),
  alt: z.string().default(""),
});

const Cta = z.object({ label: z.string().min(1), href: z.string().min(1) });

export const HeroSection = z.object({
  type: z.literal("hero"),
  kicker: z.string().optional(),
  heading: z.string().min(1),
  sub: z.string().optional(),
  cta: Cta.optional(),
  image: SectionImage,
});

export const ProgramCardsSection = z.object({
  type: z.literal("program-cards"),
  heading: z.string().optional(),
  ctaLabel: z.string().default("Contact Us For More Info"),
  programs: z
    .array(
      z.object({
        slug: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        image: SectionImage.optional(),
        href: z.string().optional(),
      }),
    )
    .min(1),
});

export const CoachGridSection = z.object({
  type: z.literal("coach-grid"),
  heading: z.string().optional(),
  coaches: z
    .array(
      z.object({
        name: z.string().min(1),
        role: z.string().optional(),
        bio: z.string().optional(),
        photo: SectionImage.optional(),
        certs: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

export const ScheduleSection = z.object({
  type: z.literal("schedule"),
  heading: z.string().optional(),
  days: z
    .array(
      z.object({
        day: z.string().min(1),
        slots: z.array(z.object({ time: z.string().min(1), name: z.string().min(1) })),
      }),
    )
    .min(1),
});

export const TestimonialsSection = z.object({
  type: z.literal("testimonials"),
  heading: z.string().min(1),
  reviews: z
    .array(
      z.object({
        name: z.string().min(1),
        quote: z.string().min(1),
        source: z.string().optional(),
        rating: z.number().int().min(1).max(5).default(5),
      }),
    )
    .min(1),
});

export const FaqSection = z.object({
  type: z.literal("faq"),
  heading: z.string().optional(),
  items: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).min(1),
});

export const CtaBandSection = z.object({
  type: z.literal("cta-band"),
  heading: z.string().min(1),
  cta: Cta,
  image: SectionImage.optional(),
});

export const LocationMapSection = z.object({
  type: z.literal("location-map"),
  heading: z.string().optional(),
  address: z.string().min(1),
  mapEmbedUrl: z.string().optional(),
  hours: z.array(z.string()).default([]),
  phone: z.string().optional(),
  cta: Cta.optional(),
});

const FormField = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "email", "tel", "textarea", "select"]).default("text"),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
});

export const ContactFormSection = z.object({
  type: z.literal("contact-form"),
  heading: z.string().optional(),
  sub: z.string().optional(),
  fields: z
    .array(FormField)
    .default([
      { name: "name", label: "Name", kind: "text", required: true },
      { name: "email", label: "Email", kind: "email", required: true },
      { name: "phone", label: "Phone", kind: "tel", required: false },
      { name: "message", label: "Message", kind: "textarea", required: false },
    ]),
  submitLabel: z.string().default("Send message"),
});

export const LeadFormSection = z.object({
  type: z.literal("lead-form"),
  heading: z.string().min(1),
  sub: z.string().optional(),
  fields: z.array(FormField).min(1),
  submitLabel: z.string().default("Book your free intro"),
  formId: z.string().min(1),
});

export const PricingSection = z.object({
  type: z.literal("pricing"),
  heading: z.string().optional(),
  plans: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.string().min(1),
        period: z.string().optional(),
        features: z.array(z.string()).default([]),
        cta: Cta.optional(),
        featured: z.boolean().default(false),
      }),
    )
    .min(1),
});

export const FeatureGridSection = z.object({
  type: z.literal("feature-grid"),
  variant: z.enum(["default", "numbered", "cards", "dark"]).default("default"),
  heading: z.string().optional(),
  items: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string().optional(),
        icon: z.string().optional(),
      }),
    )
    .min(1),
});

export const ContentBlockSection = z.object({
  type: z.literal("content-block"),
  heading: z.string().optional(),
  body: z.string().min(1),
});

export const MediaBlockSection = z.object({
  type: z.literal("media-block"),
  heading: z.string().min(1),
  body: z.string().min(1),
  image: SectionImage,
  mediaSide: z.enum(["left", "right"]).default("right"),
  cta: Cta.optional(),
});

export const StatsBandSection = z.object({
  type: z.literal("stats-band"),
  stats: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).min(1),
});

export const LogoStripSection = z.object({
  type: z.literal("logo-strip"),
  heading: z.string().optional(),
  logos: z.array(z.object({ src: imageUrl, alt: z.string().min(1) })).min(1),
});

export const Section = z.discriminatedUnion("type", [
  HeroSection,
  ProgramCardsSection,
  CoachGridSection,
  ScheduleSection,
  TestimonialsSection,
  FaqSection,
  CtaBandSection,
  LocationMapSection,
  ContactFormSection,
  LeadFormSection,
  PricingSection,
  FeatureGridSection,
  ContentBlockSection,
  MediaBlockSection,
  StatsBandSection,
  LogoStripSection,
]);

export type Section = z.infer<typeof Section>;

export const SECTION_TYPES = [
  "hero",
  "program-cards",
  "coach-grid",
  "schedule",
  "testimonials",
  "faq",
  "cta-band",
  "location-map",
  "contact-form",
  "lead-form",
  "pricing",
  "feature-grid",
  "content-block",
  "media-block",
  "stats-band",
  "logo-strip",
] as const;
