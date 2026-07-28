import { z } from "zod";
import { BusinessDoc, IntegrationsDoc, PageDocument } from "./schemas.ts";
import type { BusinessDoc as BusinessDocT, IntegrationsDoc as IntegrationsDocT, PageDocument as PageDoc, BrandCrawl } from "./schemas.ts";
import { llmJson, type ChatFn } from "./llm-json.ts";

/** Deterministic: brand signals -> IntegrationsDoc. No LLM. */
export function buildIntegrations(brand: BrandCrawl): IntegrationsDocT {
  const a = brand.analytics;
  return IntegrationsDoc.parse({
    analytics: {
      ga4: { measurementId: a.ga4 ?? null, detected: Boolean(a.ga4) },
      gtm: { containerId: a.gtm ?? null, detected: Boolean(a.gtm) },
      facebookPixel: { pixelId: a.facebookPixel && a.facebookPixel !== "detected" ? a.facebookPixel : null, detected: Boolean(a.facebookPixel) },
      hotjar: { siteId: a.hotjar ?? null, detected: Boolean(a.hotjar) },
    },
    gymSoftware: { platform: brand.software, detected: Boolean(brand.software), bookingUrl: null },
    email: { platform: null, detected: false, embedCode: null },
    chat: { platform: null, detected: false },
  });
}

const PageClassification = z.object({
  detectedType: z.string(),
  pageArchetype: z.string(),
  pageGoal: z.string(),
  primaryKeyword: z.string(),
  secondaryKeywords: z.array(z.string()),
  topicsAnswered: z.array(z.string()),
  conversionSignals: z.array(z.string()),
});

export async function classifyPage(page: PageDoc, opts: { chat: ChatFn; model: string }): Promise<PageDoc> {
  const c = await llmJson(PageClassification, {
    chat: opts.chat,
    model: opts.model,
    messages: [
      { role: "system", content: "Classify this gym web page. Return JSON with detectedType (homepage|about|coaches|programs|pricing|schedule|faq|contact|other), pageArchetype, pageGoal, primaryKeyword, secondaryKeywords, topicsAnswered, conversionSignals." },
      { role: "user", content: `URL: ${page.url}\nTitle: ${page.title}\nHeadings: ${page.headings.join(" | ")}\nBody: ${page.bodyText.slice(0, 1500)}` },
    ],
    maxRetries: 2,
  });
  return PageDocument.parse({ ...page, ...c });
}

export interface ClassifyBusinessInput {
  chat: ChatFn;
  model: string;
  pages: PageDoc[];
  brand: BrandCrawl;
}

export async function classifyBusiness(input: ClassifyBusinessInput): Promise<BusinessDocT> {
  const signals = {
    software: input.brand.software,
    analytics: Object.keys(input.brand.analytics),
    social: input.brand.socialLinks,
    pageCount: input.pages.length,
    slugs: input.pages.map((p) => p.slug),
  };
  return llmJson(BusinessDoc, {
    chat: input.chat,
    model: input.model,
    messages: [
      { role: "system", content: "Return a JSON object matching the BusinessDoc schema (techStack, marketingMaturity, businessSignals, assessment). Base it on the detected signals and page inventory." },
      { role: "user", content: `DETECTED SIGNALS: ${JSON.stringify(signals)}\n\nPAGES: ${input.pages.map((p) => `${p.slug}: ${p.bodyText.slice(0, 500)}`).join("\n")}` },
    ],
    maxRetries: 2,
  });
}
