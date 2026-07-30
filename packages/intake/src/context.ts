import { ContextDoc } from "./schemas.ts";
import type { ContextDoc as ContextDocT } from "./schemas.ts";
import type { PageDocument, IdentityCrawl, BrandCrawl } from "@milo/schema";
import type { ChatFn } from "@milo/llm";
import { llmJson } from "@milo/llm";
import { budgetPages } from "@milo/generate";

export interface AnalyzeContextInput {
  chat: ChatFn;
  model: string;
  pages: PageDocument[];
  budgets: Map<string, "full" | "truncated">;
  identity: IdentityCrawl;
  brand: BrandCrawl;
  charCeiling?: number;
}

function pageDigest(pages: PageDocument[]): string {
  return pages.map((p) => [
    `### ${p.slug} (${p.detectedType}) — ${p.url}`,
    `Title: ${p.title}`,
    `Headings: ${p.headings.join(" | ")}`,
    `Body: ${p.bodyText}`,
  ].join("\n")).join("\n\n");
}

export async function analyzeContext(input: AnalyzeContextInput): Promise<ContextDocT> {
  const ceiling = input.charCeiling ?? 100_000;
  const budgeted = budgetPages(input.pages, input.budgets, ceiling);
  const digest = pageDigest(budgeted);

  const system = [
    "You extract brand + marketing intelligence about a gym from its crawled content.",
    "Output ONLY a JSON object with this EXACT shape — every field is required (use [] for empty arrays, null only where shown):",
    `{
  "icp": { "fitnessLevel": string, "ageRange": string, "lifestage": string[], "primaryGoals": string[], "psychographics": string },
  "brandVoice": { "tone": string, "avoids": string[], "emphasizes": string[], "communicationStyle": string },
  "positioning": { "headline": string, "differentiators": string[], "vsCompetition": string, "competitivePositioning": string },
  "painPointsAddressed": string[],
  "primaryOffer": string,
  "pricingTier": string,
  "memberTransformationLanguage": string[],
  "commonObjections": string[],
  "contentPillars": string[],
  "coachAuthoritySignals": string[],
  "socialProof": { "yearsOpen": number|null, "memberCount": string|null, "mediaAchievements": string[], "reviewHighlights": string[] },
  "geographicContext": { "neighborhood": string, "city": string, "localCultureSignals": string[], "areaServed": string[] },
  "seasonalCampaigns": string[],
  "siteArchitecture": [ { "slug": string, "archetype": string, "goal": string } ]
}`,
    "siteArchitecture MUST have one entry per crawled page archetype, and EACH entry MUST include all three keys: slug, archetype, goal. Never emit a bare string or an entry missing archetype/goal.",
  ].join("\n");

  return llmJson(ContextDoc, {
    chat: input.chat,
    model: input.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        `IDENTITY: ${JSON.stringify(input.identity)}`,
        `BRAND SIGNALS: ${JSON.stringify(input.brand)}`,
        `CRAWLED PAGES:\n${digest}`,
      ].join("\n\n") },
    ],
    maxRetries: 4,
  });
}
