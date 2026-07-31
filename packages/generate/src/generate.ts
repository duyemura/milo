import { z } from "zod";
import { GymDocuments, Section, SECTION_TYPES } from "@milo/schema";
import type { GymDocuments as GymDocs, PageDocument, IdentityCrawl, BrandCrawl } from "@milo/schema";
import { llmJson, type ChatFn } from "@milo/llm";
import { buildCandidatePool, pickProgramImage, passesGate, type StatFn, type QualityGate, DEFAULT_GATE } from "./images.ts";

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
  /** Archetypes to create as placeholder pages when no crawl doc covers them. */
  placeholderArchetypes?: string[];
  /** Default ~400k chars (~100k tokens). */
  charCeiling?: number;
  /** Downloaded GMB photos with resolution metadata from intake. */
  gmbAssets?: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[];
  /** Injectable fs.stat for tests; defaults to real stat. */
  statFile?: StatFn;
  /** Image quality floor for featured media. */
  imageGate?: QualityGate;
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

interface ZodObjectLike {
  shape: Record<string, ZodFieldLike>;
}

interface ZodFieldLike {
  isOptional?: () => boolean;
  _def?: { value?: unknown };
}

interface ZodDiscriminatedUnionLike {
  _def?: { options?: unknown[] };
}

/**
 * Introspect the Section discriminated union into a compact per-type content
 * field guide (a trailing `?` marks optional/defaulted fields). This is fed to
 * the LLM so it knows the exact content shape for each section type — without
 * it, the model guesses the envelope wrong and every generation attempt fails
 * validation. Generated from the schema so it never drifts from the source.
 *
 * This reaches into Zod internals by design (the only way to keep the prompt
 * in sync with the schema automatically). It defensively validates the shape
 * and throws a clear error if a future Zod version changes the representation.
 */
export function sectionShapeGuide(): string {
  const sectionUnion = Section as unknown as ZodDiscriminatedUnionLike;
  const opts = sectionUnion._def?.options;
  if (!Array.isArray(opts)) {
    throw new Error(
      "sectionShapeGuide: expected Section to be a Zod discriminated union with _def.options. " +
        "The Zod representation may have changed; update this introspection or generate the guide from the schema another way.",
    );
  }

  const lines: string[] = [];
  for (const opt of opts) {
    const { shape } = opt as ZodObjectLike;
    if (!shape || typeof shape !== "object") {
      throw new Error("sectionShapeGuide: expected each Section option to be a Zod object with a shape.");
    }
    const typeField = shape.type as ZodFieldLike | undefined;
    const typeVal = typeField?._def?.value;
    if (typeof typeVal !== "string") {
      throw new Error("sectionShapeGuide: expected each Section option to have a string literal `type` field.");
    }
    const fields = Object.keys(shape)
      .filter((k) => k !== "type")
      .map((k) => (shape[k].isOptional?.() ? `${k}?` : k));
    lines.push(`  "${typeVal}": { ${fields.join(", ")} }`);
  }

  const emitted = new Set(lines.map((l) => l.match(/^  "([^"]+)":/)?.[1]).filter((s): s is string => !!s));
  const missing = SECTION_TYPES.filter((t) => !emitted.has(t));
  if (missing.length > 0) {
    throw new Error(`sectionShapeGuide: missing section types in generated guide: ${missing.join(", ")}`);
  }

  return lines.join("\n");
}

const FULL_CHARS = 8000;
const TRUNC_STEPS = [FULL_CHARS, 2000, 1000, 800];

/**
 * Fit page body text into the LLM context window.
 *
 * Budget rules:
 * - "truncated" pages are capped at 800 chars.
 * - "full" pages are capped at FULL_CHARS (8000) initially.
 * - If the total still exceeds `charCeiling`, progressively shrink "full" pages
 *   through the truncation steps until everything fits.
 */
export function budgetPages(
  pages: PageDocument[],
  budgets: Map<string, "full" | "truncated">,
  charCeiling: number,
): PageDocument[] {
  const cap = (p: PageDocument, n: number): PageDocument => ({ ...p, bodyText: p.bodyText.slice(0, n) });

  let working = pages.map((p) => {
    const budget = budgets.get(p.slug);
    if (budget === "truncated") return cap(p, 800);
    if (budget === "full") return cap(p, FULL_CHARS);
    return p;
  });

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
    `Images: ${p.images.map((i) => `${i.localPath ? `${i.localPath} (source: ${i.src})` : i.src}`).join(", ")}`,
  ].join("\n")).join("\n\n");
}

/**
 * After the LLM emits gym.json, audit featured-media images for quality. If a
 * program card was assigned a tiny/compressed source thumbnail, swap it for a
 * better GMB photo or large page asset that matches the program topic.
 */
async function ensureQualityImages(
  gym: GymDocs,
  pages: PageDocument[],
  gmbAssets: { localPath: string; widthPx?: number; heightPx?: number; attribution?: string }[] = [],
  statFile?: StatFn,
  gate: QualityGate = DEFAULT_GATE,
): Promise<void> {
  const pageAssets = pages.flatMap((p) => p.images.map((i) => ({ ...i, topicHint: p.slug })));
  const candidates = await buildCandidatePool(pageAssets, gmbAssets, statFile);
  if (candidates.length === 0) return;

  for (const page of gym.hierarchy.pages) {
    for (const section of page.sections) {
      if (section.section !== "program-cards" || !section.content) continue;
      const programs = (section.content as { programs?: { name?: string; description?: string; image?: { src?: string; alt?: string; localPath?: string | null } | null }[] }).programs ?? [];
      for (const program of programs) {
        if (!program || !program.name || !program.description) continue;
        const current = program.image;
        const currentCandidate = current?.localPath
          ? candidates.find((c) => c.localPath === current.localPath)
          : undefined;
        if (currentCandidate && passesGate(currentCandidate, gate)) continue;
        const replacement = pickProgramImage(program.name, program.description, candidates, gate);
        if (replacement) {
          program.image = {
            src: replacement.src,
            alt: current?.alt || replacement.alt || program.name,
            localPath: replacement.localPath,
          };
        }
      }
    }
  }
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
    "- Every hero/media/logo/coach image needs an image object {src, alt, localPath?}. Set `src` to the original URL from the page's Images list and `localPath` to the matching downloaded local path under /assets/... when present. Templates prefer localPath over src, so keeping src as the canonical/original URL preserves the source reference while the renderer uses the local copy.",
    "- identity.name and tagline come from the crawled homepage / provided identity doc.",
    "- Build one page per meaningful archetype the crawl supports (home/index, about, programs, pricing, contact). Preserve the gym's own words wherever possible.",
    ...(input.placeholderArchetypes?.length ? [
      `PLACEHOLDER ARCHETYPES (create these pages with obvious placeholder content if no crawl doc covers them): ${input.placeholderArchetypes.join(", ")}`,
      "- Placeholder copy must clearly signal it is awaiting real content (e.g. 'Add coach bio here', 'Pricing details to be added') so an operator knows to edit or delete the page.",
      "- Still create the page slug, title, meta.description, and a single appropriate section for each placeholder archetype.",
    ] : []),
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

  await ensureQualityImages(gym, input.pages, input.gmbAssets ?? [], input.statFile, input.imageGate);

  return { gym };
}
