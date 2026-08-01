import { describe, expect, it } from "vitest";
import type { ChatFn } from "@milo/llm";
import { runKeywordCycle } from "../src/run.ts";
import { seedQueries } from "../src/research.ts";
import { PageBriefSchema, type GymContext } from "../src/types.ts";

const CTX: GymContext = {
  siteId: "s1",
  companyId: "c1",
  companyName: "Speakeasy of Strength",
  sourceUrl: "https://speakeasyofstrength.com",
  city: "New York",
  state: "NY",
  activities: ["strength training", "personal training", "olympic lifting"],
  differentiators: ["women-owned", "speakeasy vibe"],
};

/** Scripted OpenRouter-style chat: routes by prompt content. */
const fakeChat: ChatFn = async ({ messages }) => {
  const sys = String(messages[0]?.content ?? "");
  if (sys.includes("veteran reporting")) {
    return { content: JSON.stringify({ digest: "Brooklyn strength searchers want a real barbell gym." }) } as never;
  }
  if (sys.includes("cluster the searches")) {
    return {
      content: JSON.stringify({
        clusters: [
          { cluster: "strength training gyms", primaryKeyword: "strength training brooklyn", intent: "transactional", fit: 0.95, effort: "low", novelty: 0.9, suggestions: ["strength training brooklyn", "strength gym brooklyn", "olympic lifting gym nyc"] },
          { cluster: "Strength training gyms", primaryKeyword: "strength training brooklyn", intent: "transactional", fit: 0.9, effort: "low", novelty: 0.8, suggestions: ["strength training brooklyn"] },
          { cluster: "beginner strength", primaryKeyword: "strength training for beginners", intent: "transactional", fit: 0.8, effort: "medium", novelty: 0.7, suggestions: ["strength training for beginners", "strength program beginners"] },
        ],
      }),
    } as never;
  }
  if (sys.includes("page briefs")) {
    return {
      content: JSON.stringify({
        suggestedUrl: "/strength-training-brooklyn/",
        goal: "Turn 'strength training brooklyn' searchers into booked intro sessions within one visit.",
        outline: [
          { role: "hero", notes: "Lead with the exact phrase + NYC; promise the intro session." },
          { role: "social-proof", notes: "Member strength stories from Brooklyn members." },
          { role: "how-it-works", notes: "Intro class → bar path → programming." },
          { role: "offer", notes: "Free strategy session CTA." },
        ],
        localSignals: ["Brooklyn", "Williamsburg bridge", "NYC"],
      }),
    } as never;
  }
  throw new Error("unmocked prompt " + sys.slice(0, 60));
};

const fakeSuggest = async (q: string): Promise<string[]> => {
  if (q.startsWith("strength training")) return ["strength training brooklyn", "strength training for beginners", "strength training program"];
  if (q.startsWith("personal training")) return ["personal training brooklyn", "personal trainer nyc"];
  return [];
};

describe("keyword-brain", () => {
  it("seedQueries covers activity×city with near-me", () => {
    const seeds = seedQueries(["crossfit", "hiit"], "Torrance");
    expect(seeds).toContain("crossfit Torrance");
    expect(seeds).toContain("hiit classes Torrance");
    expect(seeds).toContain("crossfit near me");
  });

  it("full cycle: research → deduped clusters → briefs → digest, offline", async () => {
    const out = await runKeywordCycle({
      context: CTX,
      chat: fakeChat,
      model: "test-model",
      suggest: fakeSuggest,
      onLog: () => {},
    });

    // dedupe: "strength training gyms" appears twice w/ different case → one cluster
    const names = out.clusters.map((c) => c.cluster.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(out.clusters).toHaveLength(2);

    // briefs are schema-valid handshakes with real-keyword payloads
    expect(out.briefs).toHaveLength(2);
    for (const b of out.briefs) {
      PageBriefSchema.parse(b);
      expect(b.siteId).toBe("s1");
      expect(b.status).toBe("pending");
      expect(b.secondaryKeywords).not.toContain(b.primaryKeyword);
    }
    const first = out.briefs[0];
    expect(first?.suggestedUrl).toBe("/strength-training-brooklyn/");
    expect(first?.intent).toBe("transactional");

    expect(out.digest).toContain("Brooklyn");
  });

  it("empty pools → zero clusters and an honest digest, not a crash", async () => {
    const out = await runKeywordCycle({
      context: CTX,
      chat: fakeChat,
      model: "test-model",
      suggest: async () => [],
      onLog: () => {},
    });
    expect(out.clusters).toHaveLength(0);
    expect(out.briefs).toHaveLength(0);
    expect(out.digest).toContain("No usable local search clusters");
  });

  it("no activities → fails loudly", async () => {
    await expect(
      runKeywordCycle({
        context: { ...CTX, activities: [] },
        chat: fakeChat,
        model: "test-model",
        suggest: fakeSuggest,
        onLog: () => {},
      }),
    ).rejects.toThrow(/no activities/);
  });
});
