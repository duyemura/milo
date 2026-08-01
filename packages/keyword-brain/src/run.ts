import { z } from "zod";
import { llmJson, type ChatFn } from "@milo/llm";
import type { BriefRunResult, GymContext, SuggestFn } from "./types.ts";
import { seedQueries, research, googleSuggest } from "./research.ts";
import { score } from "./score.ts";
import { brief } from "./brief.ts";

export interface RunOpts {
  context: GymContext;
  neighborhoods?: string[];
  chat: ChatFn;
  model: string;
  suggest?: SuggestFn;
  topN?: number;
  /** Job-log line sink. */
  onLog: (line: string) => void;
}

/**
 * The full local-marketing cycle: research → score → brief → digest.
 * Failure posture: empty pools → digest says nothing found (not an error); dead LLM
 * paths throw (they're real failures worth surfacing as a failed job).
 */
export async function runKeywordCycle(opts: RunOpts): Promise<BriefRunResult> {
  const { context, chat, model, topN = 12, onLog } = opts;
  const suggest = opts.suggest ?? googleSuggest;

  onLog(`activities: ${context.activities.join(", ") || "(none derived)"}`);
  if (context.activities.length === 0) throw new Error("discover produced no activities — cannot research keywords");

  const seeds = seedQueries(context.activities, context.city, opts.neighborhoods ?? []);
  onLog(`autocomplete seeds: ${seeds.length}`);
  const pools = await research(seeds, suggest, (line) => onLog(`note: ${line}`));
  const poolCount = pools.reduce((n, p) => n + p.suggestions.length, 0);
  onLog(`suggestions mined: ${poolCount} from ${pools.length}/${seeds.length} seeds`);

  const clusters = await score({ pools, context, chat, model, topN });
  onLog(`clusters after scoring: ${clusters.length}`);
  if (clusters.length === 0) {
    return { clusters, briefs: [], digest: fallbackDigest(context) };
  }

  const briefs: BriefRunResult["briefs"] = [];
  for (const cluster of clusters) {
    try {
      const b = await brief({ cluster, context, chat, model });
      briefs.push(b);
      onLog(`brief: [${b.intent}] ${b.primaryKeyword} → ${b.suggestedUrl}`);
    } catch (err) {
      onLog(`dropped cluster "${cluster.cluster}": ${err instanceof Error ? err.message.split("\n")[0] : "brief failed"}`);
    }
  }

  const digest = await digestOf({ context, clusters, briefs, chat, model });
  return { clusters, briefs, digest };
}

function fallbackDigest(context: GymContext): string {
  return `No usable local search clusters surfaced for ${context.companyName} (${context.city}, ${context.state}) this cycle — the autocomplete pools were thin. Worth re-running, and worth checking that the activity list reflects the real offering mix.`;
}

const DigestSchema = z.object({ digest: z.string() });

/** The veteran voice: judgment, not a data dump. */
async function digestOf(opts: {
  context: GymContext;
  clusters: unknown[];
  briefs: BriefRunResult["briefs"];
  chat: ChatFn;
  model: string;
}): Promise<string> {
  const { context, briefs, chat, model } = opts;
  const r = await llmJson(DigestSchema, {
    chat,
    model,
    messages: [
      {
        role: "system",
        content: `You ARE a 15-year local-search marketing veteran reporting to a busy gym owner in 3-5
plain sentences: what the local searches are really about for THEIR offerings, which 1-2 opportunities matter
most and why, and what you did about it (page briefs written). Sentence case, no jargon, no emoji
(exceptions okay: one). Never say "leverage" or "synergy".`,
      },
      {
        role: "user",
        content: JSON.stringify({
          gym: { name: context.companyName, city: context.city },
          briefs: briefs.map((b) => ({ keyword: b.primaryKeyword, intent: b.intent, url: b.suggestedUrl })),
        }),
      },
    ],
  });
  return r.digest;
}
