import { ContextDoc } from "./schemas.ts";
import type { ContextDoc as ContextDocT } from "./schemas.ts";
import type { PageDocument, IdentityCrawl, BrandCrawl } from "@milo/schema";
import type { ChatFn } from "@milo/llm";
import { llmJson } from "@milo/llm";
import { budgetPages } from "@milo/generate";
import { budgetGmbReviews } from "./gmb-budget.ts";
import type { Asset } from "@milo/storage";

export interface AnalyzeContextInput {
  chat: ChatFn;
  model: string;
  pages: PageDocument[];
  budgets: Map<string, "full" | "truncated">;
  identity: IdentityCrawl;
  brand: BrandCrawl;
  assets?: Asset[];
  charCeiling?: number;
}

// Split schema: brand/copy fields driven by page text
const ContextDocA = ContextDoc.pick({
  icp: true,
  brandVoice: true,
  positioning: true,
  painPointsAddressed: true,
  primaryOffer: true,
  pricingTier: true,
  memberTransformationLanguage: true,
  commonObjections: true,
  contentPillars: true,
  coachAuthoritySignals: true,
});

// Split schema: proof/structure fields driven by GMB + site shape
const ContextDocB = ContextDoc.pick({
  socialProof: true,
  geographicContext: true,
  seasonalCampaigns: true,
  siteArchitecture: true,
});

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
  const budgeted = budgetPages(input.pages, input.budgets, Math.floor(ceiling / 2));
  const digest = pageDigest(budgeted);

  const gmb = input.identity;
  const gmbContext = gmb?.found ? {
    summary: gmb.editorialSummary?.text,
    primaryType: gmb.primaryType,
    types: gmb.types,
    rating: gmb.rating,
    reviewCount: gmb.reviewCount,
    hours: gmb.openingHoursSpecification,
    priceLevel: gmb.priceLevel,
    accessibility: gmb.accessibilityOptions,
    address: gmb.formattedAddress,
    addressParts: gmb.addressParts,
    reviewHighlights: budgetGmbReviews(gmb.reviews, { maxReviews: 10, maxChars: 8000 }).map((r) => ({
      rating: r.rating,
      text: r.text?.text,
      time: r.relativePublishTimeDescription,
    })),
    images: input.assets?.map((a) => ({
      file: a.file,
      widthPx: a.dimensions.w,
      heightPx: a.dimensions.h,
      attribution: a.attribution,
    })) ?? [],
  } : null;

  const userContent = [
    `IDENTITY: ${JSON.stringify(input.identity)}`,
    `BRAND SIGNALS: ${JSON.stringify(input.brand)}`,
    ...(gmbContext ? [`GMB CONTEXT: ${JSON.stringify(gmbContext)}`] : []),
    `CRAWLED PAGES:\n${digest}`,
  ].join("\n\n");

  const [a, b] = await Promise.all([
    llmJson(ContextDocA, {
      chat: input.chat,
      model: input.model,
      maxTokens: 8000,
      messages: [
        {
          role: "system",
          content: [
            "You extract brand + marketing intelligence about a gym from its crawled page content.",
            "Output ONLY a JSON object with this EXACT shape — every field is required (use [] for empty arrays):",
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
  "coachAuthoritySignals": string[]
}`,
          ].join("\n"),
        },
        { role: "user", content: userContent },
      ],
      maxRetries: 4,
    }),

    llmJson(ContextDocB, {
      chat: input.chat,
      model: input.model,
      maxTokens: 4000,
      messages: [
        {
          role: "system",
          content: [
            "You extract proof, geography, and site structure signals about a gym from its GMB data and crawled pages.",
            "Output ONLY a JSON object with this EXACT shape — every field is required (use [] for empty arrays, null only where shown):",
            `{
  "socialProof": { "yearsOpen": number|null, "memberCount": string|null, "mediaAchievements": string[], "reviewHighlights": string[] },
  "geographicContext": { "neighborhood": string, "city": string, "localCultureSignals": string[], "areaServed": string[] },
  "seasonalCampaigns": string[],
  "siteArchitecture": [ { "slug": string, "archetype": string, "goal": string } ]
}`,
            "siteArchitecture MUST have one entry per crawled page. Each entry MUST include slug, archetype, and goal.",
          ].join("\n"),
        },
        { role: "user", content: userContent },
      ],
      maxRetries: 4,
    }),
  ]);

  return { ...a, ...b };
}
