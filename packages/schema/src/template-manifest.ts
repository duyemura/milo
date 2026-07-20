import { z } from "zod";
import { SECTION_TYPES } from "./sections.ts";
import { PAGE_ARCHETYPES } from "./site-content.ts";

/**
 * Template manifest — the machine-readable half of a template's documentation.
 * Site builds (generate step, AI assistant) read this to understand how to
 * compose pages with the template. A manifest MUST document every section
 * type in the closed vocabulary; validation fails otherwise, so template
 * docs cannot silently drift from the contract.
 */

const ComponentDoc = z.object({
  description: z.string().min(10),
  variants: z.record(z.string(), z.string()).optional(),
  usage: z.string().min(10),
});

/** "feature-grid#dark" = section type + variant hint for composition recipes. */
const sectionRef = z.string().refine(
  (s) => (SECTION_TYPES as readonly string[]).includes(s.split("#")[0]),
  (s) => ({ message: `"${s}" does not reference a known section type` }),
);

const ArchetypeRecipe = z.object({
  sections: z.array(sectionRef).min(1),
  notes: z.string().optional(),
});

export const TemplateManifest = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(20),
    tokens: z.record(z.string(), z.string()),
    components: z.record(z.enum(SECTION_TYPES), ComponentDoc),
    archetypes: z.record(z.enum(PAGE_ARCHETYPES), ArchetypeRecipe),
  })
  .refine((m) => SECTION_TYPES.every((t) => t in m.components), {
    message: "manifest must document every section type in the vocabulary",
  });

export type TemplateManifest = z.infer<typeof TemplateManifest>;
