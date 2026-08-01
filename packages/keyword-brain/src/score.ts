import { z } from "zod";
import { llmJson, type ChatFn } from "@milo/llm";
import type { GymContext, KeywordCluster } from "./types.ts";

const ScoreSchema = z.object({
  clusters: z.array(
    z.object({
      cluster: z.string(),
      primaryKeyword: z.string(),
      intent: z.enum(["transactional", "informational"]),
      fit: z.number().min(0).max(1),
      effort: z.enum(["low", "medium", "high"]),
      novelty: z.number().min(0).max(1),
      suggestions: z.array(z.string()).default([]),
    }),
  ),
});

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Score + cluster a suggestion pool with the LLM, then deterministically dedupe
 * cluster labels (case/punct-insensitive, first occurrence wins). Never invents
 * keywords — clusters are unions of actual suggestions only.
 */
export async function score(opts: {
  pools: { query: string; suggestions: string[] }[];
  context: GymContext;
  chat: ChatFn;
  model: string;
  topN?: number;
}): Promise<KeywordCluster[]> {
  const { pools, context, chat, model, topN = 12 } = opts;
  if (pools.length === 0) return [];

  const catalog: string[] = [];
  for (const p of pools.slice(0, 30)) catalog.push(`SEED "${p.query}": ${p.suggestions.join(" | ")}`);

  const r = await llmJson(ScoreSchema, {
    chat,
    model,
    messages: [
      {
        role: "system",
        content: `You are a local-SEO analyst for small fitness businesses. Given Google autocomplete
suggestions and the gym's real offerings, cluster the searches by user intent. Rules:
- cluster = a distinct search INTENT (e.g. "beginner crossfit", "hiit classes", "gym with childcare")
- primaryKeyword = the highest-intent actual suggestion in the cluster (never invent phrasings)
- intent: transactional (ready to join/book/try) vs informational (research/fitness content)
- fit 0..1: how well it matches what THIS gym offers (they don't do what they don't do)
- effort: low (local/niche phrasing) | medium | high (broad competitive head term)
- novelty 0..1: 1 = the gym likely has NO page for this intent today
- suggestions: 3-6 actual autocomplete strings forming the cluster (verbatim)
Drop junk: brand names of OTHER gyms, national/program phrasings with no local tie, navigational queries
("speakeasy login"). Return at most ${topN} clusters, best first. JSON only.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          gym: { name: context.companyName, city: context.city, activities: context.activities, differentiators: context.differentiators },
          autocomplete: catalog.join("\n"),
        }),
      },
    ],
  });

  const seen = new Set<string>();
  const out: KeywordCluster[] = [];
  for (const c of r.clusters) {
    const key = norm(c.cluster);
    if (seen.has(key) || c.suggestions.length === 0) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= topN) break;
  }
  return out;
}
