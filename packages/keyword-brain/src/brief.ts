import { z } from "zod";
import { llmJson, type ChatFn } from "@milo/llm";
import { PageBriefSchema, type GymContext, type KeywordCluster } from "./types.ts";

const BriefBodySchema = z.object({
  suggestedUrl: z.string(),
  goal: z.string(),
  outline: z.array(z.object({ role: z.string(), notes: z.string() })).min(3),
  localSignals: z.array(z.string()).min(1),
});

/** One PageBrief per cluster. Never invents keywords — the brief wraps the cluster's real suggestions. */
export async function brief(opts: {
  cluster: KeywordCluster;
  context: GymContext;
  chat: ChatFn;
  model: string;
}): Promise<typeof PageBriefSchema._type> {
  const { cluster, context, chat, model } = opts;
  const body = await llmJson(BriefBodySchema, {
    chat,
    model,
    messages: [
      {
        role: "system",
        content: `You write page briefs for a local-SEO site builder. The brief tells a builder WHAT the page
must achieve and WHAT each section covers — never HOW to build it (no layouts, components, or styling).
- suggestedUrl: /${cluster.cluster.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}/ style slug
- goal: one measurable sentence a 15-year local marketer would write
- outline: 4–7 ordered sections. roles from the site's vocabulary when obvious
  (hero, value-prop, social-proof, how-it-works, offer, faq, map/hours, cta); notes = what the section
  must say to win this search intent (mention the keyword where natural, city + differentiators)
- localSignals: city/neighborhood/proximity references to weave in (real places, from the cluster + geography)
JSON only.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          cluster: { ...cluster, suggestions: cluster.suggestions.slice(0, 6) },
          gym: { name: context.companyName, city: context.city, state: context.state, differentiators: context.differentiators },
        }),
      },
    ],
  });

  return PageBriefSchema.parse({
    siteId: context.siteId,
    companyId: context.companyId,
    keywordCluster: cluster.cluster,
    primaryKeyword: cluster.primaryKeyword,
    secondaryKeywords: cluster.suggestions.filter((s) => s !== cluster.primaryKeyword),
    intent: cluster.intent,
    suggestedUrl: body.suggestedUrl,
    pageType: "local-landing",
    goal: body.goal,
    outline: body.outline,
    differentiators: context.differentiators,
    localSignals: body.localSignals,
    status: "pending",
  });
}
