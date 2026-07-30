import { z } from "zod";
import { GymDocuments, Section, SECTION_TYPES } from "@milo/schema";
import type { GymDocuments as GymDocs, PageDocument, IdentityCrawl, BrandCrawl } from "@milo/schema";
import { llmJson, type ChatFn } from "@milo/llm";

export interface GenerateSiteInput {
  chat: ChatFn;
  model: string;
  identity: IdentityCrawl;
  brand: BrandCrawl;
  pages: PageDocument[];
  budgets: Map<string, "full" | "truncated">;
  /** Marketing intelligence doc produced by intake (optional but useful for tone/positioning). */
  context?: Record<string, unknown>;
  /** Business assessment doc produced by intake (optional). */
  business?: Record<string, unknown>;
  /** Default ~400k chars (~100k tokens). */
  charCeiling?: number;
}

export interface GenerateSiteResult {
  gym: GymDocs;
}

/**
 * GymDocuments only shape-checks section instances (content is a loose z.record).
 * At generation time we ALSO validate each section's content against its Section
 * schema, so malformed content is caught inside llmJson's retry loop and the LLM
 * self-corrects — instead of surfacing as a broken renderer build later. The
 * renderer still runs Section.safeParse independently; this is the earlier gate.
 */
const GymDocumentsStrict = GymDocuments.superRefine((doc, ctx) => {
  doc.hierarchy.pages.forEach((page, pi) => {
    page.sections.forEach((inst, si) => {
      // Section schemas keep `type` + content fields as siblings (spread), so we
      // merge the instance's content up alongside its type before validating.
      const result = Section.safeParse({ type: inst.section, ...inst.content });
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hierarchy", "pages", pi, "sections", si, "content"],
          message: `Invalid content for "${inst.section}": ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        });
      }
    });
  });
});

/**
 * Introspect the Section discriminated union into a compact per-type content
 * field guide (a trailing `?` marks optional/defaulted fields). This is fed to
 * the LLM so it knows the exact content shape for each section type — without
 * it, the model guesses the envelope wrong and every generation attempt fails
 * validation. Generated from the schema so it never drifts from the source.
 */
export function sectionShapeGuide(): string {
  const opts = (Section as unknown as { _def: { options: unknown[] } })._def.options;
  const lines: string[] = [];
  for (const opt of opts) {
    const o = opt as { shape: Record<string, { isOptional?: () => boolean; _def?: { value?: unknown } }> };
    const shape = o.shape;
    const typeVal = shape.type?._def?.value;
    const fields = Object.keys(shape)
      .filter((k) => k !== "type")
      .map((k) => (shape[k].isOptional?.() ? `${k}?` : k));
    lines.push(`  "${String(typeVal)}": { ${fields.join(", ")} }`);
  }
  return lines.join("\n");
}

const FULL_CHARS = 8000;
const TRUNC_STEPS = [FULL_CHARS, 2000, 1000, 800];

/** Estimate ~4 chars/token; keep total input body under `charCeiling`. */
export function budgetPages(
  pages: PageDocument[],
  budgets: Map<string, "full" | "truncated">,
  charCeiling: number,
): PageDocument[] {
  const cap = (p: PageDocument, n: number): PageDocument => ({ ...p, bodyText: p.bodyText.slice(0, n) });

  // Truncated pages start at 800.
  let working = pages.map((p) => (budgets.get(p.slug) === "truncated" ? cap(p, 800) : p));

  for (const step of TRUNC_STEPS) {
    const total = working.reduce((n, p) => n + p.bodyText.length, 0);
    if (total <= charCeiling) return working;
    working = working.map((p) => (budgets.get(p.slug) === "full" ? cap(p, step) : p));
  }
  return working;
}

function pageDigest(pages: PageDocument[]): string {
  return pages.map((p) => [
    `### ${p.slug} (${p.detectedType}) — ${p.url}`,
    `Title: ${p.title}`,
    `Headings: ${p.headings.join(" | ")}`,
    `Body: ${p.bodyText}`,
    `Images: ${p.images.map((i) => i.localPath ?? i.src).join(", ")}`,
  ].join("\n")).join("\n\n");
}

export async function generateSite(input: GenerateSiteInput): Promise<GenerateSiteResult> {
  const ceiling = input.charCeiling ?? 400_000;
  const budgeted = budgetPages(input.pages, input.budgets, ceiling);
  const digest = pageDigest(budgeted);

  const system = [
    "You convert a gym's business docs and crawled website content into a GymDocuments JSON object.",
    "Output ONLY a JSON object with this EXACT shape:",
    `{
  "identity": { "name": string, "tagline": string, "phone"?: string, "address"?: string, "email"?: string, "siteUrl"?: string, "openingHoursSpecification"?: [...] },
  "brand": {
    "colors": { "primary": "#rrggbb", "accent": "#rrggbb", "surface": "#rrggbb", "text": "#rrggbb", "muted": "#rrggbb" },
    "fonts": { "display": string, "body": string },
    "space": { "sm": "8px", "md": "16px", "lg": "32px" },
    "radius": { "button": "6px", "card": "12px" }
  },
  "hierarchy": { "pages": [
    { "slug": string, "title": string, "meta": { "description": string },
      "sections": [ { "section": "<one type below>", "content": { ...that type's fields... } } ] }
  ] }
}`,
    "HARD RULES:",
    "- Every page MUST include slug, title, meta.description, and >=1 section.",
    '- Each section is { "section": "<type>", "content": {...} }. The type name goes in "section"; ALL other fields go INSIDE "content" (never at the top level, never as a "type" key).',
    "- Use ONLY these section types. content must contain exactly these fields (a trailing ? = optional):",
    sectionShapeGuide(),
    "- All colors are 6-digit hex (#rrggbb). Prefer the BRAND SIGNALS colors; map them to the 5 slots with good contrast (surface = light background, text = dark).",
    "- Every hero/media/logo image needs an image object {src, alt}. Use an image URL from that page's Images list; if none, use the gym logo URL from BRAND SIGNALS.",
    "- identity.name and tagline come from the crawled homepage / provided identity doc.",
    "- Build one page per meaningful archetype the crawl supports (home/index, about, programs, pricing, contact). Preserve the gym's own words wherever possible.",
  ].join("\n");

  const userParts = [
    `IDENTITY (from Google Places / crawl): ${JSON.stringify(input.identity)}`,
    `BRAND SIGNALS: ${JSON.stringify(input.brand)}`,
    ...(input.context ? [`MARKETING CONTEXT: ${JSON.stringify(input.context)}`] : []),
    ...(input.business ? [`BUSINESS ASSESSMENT: ${JSON.stringify(input.business)}`] : []),
    `AVAILABLE SECTION TYPES (closed vocabulary): ${SECTION_TYPES.join(", ")}`,
    `CRAWLED PAGES:\n${digest}`,
  ];

  const gym = await llmJson(GymDocumentsStrict, {
    chat: input.chat,
    model: input.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userParts.join("\n\n") },
    ],
    maxRetries: 4,
  });

  return { gym };
}
