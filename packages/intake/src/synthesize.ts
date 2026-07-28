import { z } from "zod";
import { GymDocuments, Section, SECTION_TYPES } from "@milo/schema";
import type { GymDocuments as GymDocs } from "@milo/schema";
import { ContextDoc } from "./schemas.ts";
import type { ContextDoc as ContextDocT, PageDocument, IdentityCrawl, BrandCrawl } from "./schemas.ts";
import { llmJson, type ChatFn } from "./llm-json.ts";

/**
 * GymDocuments only shape-checks section instances (content is a loose z.record).
 * At synthesis time we ALSO validate each section's content against its Section
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

export interface SynthesizeInput {
  chat: ChatFn;
  model: string;
  pages: PageDocument[];
  budgets: Map<string, "full" | "truncated">;
  identity: IdentityCrawl;
  brand: BrandCrawl;
  charCeiling?: number;   // default ~ 128k tokens * 4 chars = 512k, minus overhead
}

export interface SynthesizeResult {
  gym: GymDocs;
  context: ContextDocT;
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

export async function synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
  const ceiling = input.charCeiling ?? 400_000;
  const budgeted = budgetPages(input.pages, input.budgets, ceiling);
  const digest = pageDigest(budgeted);

  const shared = [
    `You are building a gym's marketing website from its own crawled content. Preserve the gym's own words wherever possible.`,
    `IDENTITY (from Google Places): ${JSON.stringify(input.identity)}`,
    `BRAND SIGNALS: ${JSON.stringify(input.brand)}`,
    `AVAILABLE SECTION TYPES (closed vocabulary): ${SECTION_TYPES.join(", ")}`,
    `CRAWLED PAGES:\n${digest}`,
  ].join("\n\n");

  const gym = await llmJson(GymDocumentsStrict, {
    chat: input.chat,
    model: input.model,
    messages: [
      { role: "system", content: "Return a JSON object matching the GymDocuments schema: { identity, brand, hierarchy }. Every page needs >=1 section drawn from the section vocabulary. Each section's `content` must contain exactly the fields that section type requires (e.g. a hero needs heading + image{src,alt}). Use local asset paths (/assets/...) for images when present." },
      { role: "user", content: shared },
    ],
    maxRetries: 3,
  });

  const context = await llmJson(ContextDoc, {
    chat: input.chat,
    model: input.model,
    messages: [
      { role: "system", content: "Return a JSON object matching the ContextDoc schema — brand + marketing intelligence (ICP, voice, positioning, objections, SEO)." },
      { role: "user", content: shared },
    ],
    maxRetries: 3,
  });

  return { gym, context };
}
