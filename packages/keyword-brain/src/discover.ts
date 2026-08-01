import { z } from "zod";
import { llmJson, type ChatFn } from "@milo/llm";
import type { GymContext } from "./types.ts";

/**
 * Assemble gym context. City/state are REQUIRED facts and must come from the caller
 * (seed payload; never guessed). Activities/differentiators are derived with the LLM
 * from whatever we know about the gym (name, URL, seed docs when provided).
 */
const DiscoverSchema = z.object({
  activities: z.array(z.string()).min(1).max(10),
  differentiators: z.array(z.string()).max(6).default([]),
  neighborhoods: z.array(z.string()).max(4).default([]),
});

export interface DiscoverInput {
  siteId: string;
  companyId: string;
  companyName: string;
  sourceUrl: string | null;
  city: string;
  state: string;
  /** Optional text evidence (seed docs, captured copy, reviews) to ground on. */
  evidence?: string;
}

export async function discover(opts: {
  input: DiscoverInput;
  chat: ChatFn;
  model: string;
}): Promise<{ context: GymContext; neighborhoods: string[] }> {
  const { input, chat, model } = opts;
  const result = await llmJson(DiscoverSchema, {
    chat,
    model,
    messages: [
      {
        role: "system",
        content: `You research local fitness businesses for search marketing. From the facts given,
list: (1) activities this gym actually offers as SHORT search-meaningful phrases (e.g. "crossfit",
"personal training", "hiit", "kids jiu-jitsu") — what a local would type, not marketing names;
(2) differentiators that make it locally notable (empty if unclear);
(3) up to 4 neighborhoods/districts of its city a local might search by (empty if unclear). JSON only.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          name: input.companyName,
          url: input.sourceUrl,
          city: input.city,
          state: input.state,
          evidence: (input.evidence ?? "").slice(0, 12_000),
        }),
      },
    ],
  });

  return {
    context: {
      siteId: input.siteId,
      companyId: input.companyId,
      companyName: input.companyName,
      sourceUrl: input.sourceUrl,
      city: input.city,
      state: input.state,
      activities: result.activities,
      differentiators: result.differentiators,
    },
    neighborhoods: result.neighborhoods,
  };
}
