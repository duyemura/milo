import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ChatFn } from "@milo/llm";
import { testApp, testDb, seedRegistry, testConfig } from "./helpers.ts";
import { runJob } from "../src/jobs/runner.ts";

const fakeChat: ChatFn = async ({ messages }) => {
  const sys = String(messages[0]?.content ?? "");
  if (sys.includes("research local fitness businesses")) {
    return { content: JSON.stringify({ activities: ["crossfit", "personal training"], differentiators: ["coached, not crowded"], neighborhoods: ["Old Torrance"] }) } as never;
  }
  if (sys.includes("veteran reporting")) {
    return { content: JSON.stringify({ digest: "Torrance strength searchers want coaching, not a weight room." }) } as never;
  }
  if (sys.includes("page briefs")) {
    return {
      content: JSON.stringify({
        suggestedUrl: "/crossfit-classes-torrance/",
        goal: "Convert 'crossfit classes torrance' intent into trial bookings.",
        outline: [
          { role: "hero", notes: "Phrase match + Torrance; trial CTA above fold." },
          { role: "social-proof", notes: "Member PR stories with first names." },
          { role: "how-it-works", notes: "Trial class → foundations → programming." },
          { role: "cta", notes: "Book free intro." },
        ],
        localSignals: ["Torrance", "Old Torrance", "South Bay"],
      }),
    } as never;
  }
  if (sys.includes("cluster the searches")) {
    return {
      content: JSON.stringify({
        clusters: [
          { cluster: "crossfit classes", primaryKeyword: "crossfit classes torrance", intent: "transactional", fit: 0.9, effort: "low", novelty: 0.9, suggestions: ["crossfit classes torrance", "crossfit gym torrance"] },
        ],
      }),
    } as never;
  }
  throw new Error("unmocked " + sys.slice(0, 50));
};

async function siteWithSeed(db: Awaited<ReturnType<typeof testDb>>) {
  await seedRegistry(db);
  await db
    .insertInto("sites")
    .values({
      id: "kw-site",
      workspaceId: "ws1",
      companyId: "co1",
      seedType: "template",
      sourceUrl: "https://ironanchor.example.com",
      slug: null,
      status: "built",
      stage: "building",
      active: 1,
      createdAt: new Date().toISOString(),
    })
    .execute();
  await db
    .insertInto("jobs")
    .values({
      id: "seed-kw",
      workspaceId: "ws1",
      companyId: "co1",
      siteId: "kw-site",
      type: "seed",
      status: "succeeded",
      payload: JSON.stringify({ sourceUrl: "https://ironanchor.example.com", name: "Iron Anchor", city: "Denver", state: "CO", templateId: "modern" }),
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    })
    .execute();
}

describe("keyword-cycle job through the runner", () => {
  it("discovers from seed payload, produces briefs, writes drop + page_briefs", async () => {
    const db = await testDb();
    await siteWithSeed(db);
    const dataDir = await mkdtemp(path.join(tmpdir(), "kw-cycle-"));
    const config = testConfig({ dataDir });
    const site = await db.selectFrom("sites").selectAll().where("id", "=", "kw-site").executeTakeFirstOrThrow();
    const job = {
      id: "kw-job",
      workspaceId: "ws1",
      companyId: "co1",
      siteId: "kw-site",
      type: "keyword-cycle" as const,
      status: "running" as const,
      payload: "{}",
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };

    const digest = await runJob({
      db,
      config,
      job,
      site,
      spawn: async () => ({ code: 1, lines: [] }),
      brain: {
        chat: fakeChat,
        suggest: async (q) => (q.startsWith("crossfit") ? ["crossfit classes torrance", "crossfit gym torrance"] : []),
      },
    });

    expect(digest).toContain("Torrance");

    const rows = await db.selectFrom("page_briefs").selectAll().where("siteId", "=", "kw-site").execute();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as { primaryKeyword: string; suggestedUrl: string };
    expect(payload.primaryKeyword).toBe("crossfit classes torrance");
    expect(payload.suggestedUrl).toBe("/crossfit-classes-torrance/");

    const drop = path.join(String(config.dataDir), "briefs", "kw-site.json");
    expect(existsSync(drop)).toBe(true);

    await rm(dataDir, { recursive: true, force: true });
  });

  it("brief routes list/patch statuses and re-emit the drop", async () => {
    const { app, db } = await testApp();
    await siteWithSeed(db);
    await db
      .insertInto("page_briefs")
      .values({
        id: "pb1",
        workspaceId: "ws1",
        companyId: "co1",
        siteId: "kw-site",
        payload: JSON.stringify({ siteId: "kw-site", companyId: "co1", keywordCluster: "crossfit classes", primaryKeyword: "crossfit classes torrance", secondaryKeywords: [], intent: "transactional", suggestedUrl: "/crossfit-classes-torrance/", pageType: "local-landing", goal: "Trial bookings.", outline: [], differentiators: [], localSignals: ["Torrance"], status: "pending" }),
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .execute();

    const list = await app.inject({ method: "GET", url: "/api/v1/sites/kw-site/briefs" });
    expect(list.statusCode).toBe(200);
    const { briefs } = list.json() as { briefs: { id: string; status: string }[] };
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.status).toBe("pending");

    const patch = await app.inject({ method: "PATCH", url: "/api/v1/briefs/pb1", payload: { status: "built" } });
    expect(patch.statusCode).toBe(200);
    const again = await app.inject({ method: "GET", url: "/api/v1/sites/kw-site/briefs" });
    expect((again.json() as { briefs: { status: string }[] }).briefs[0]?.status).toBe("built");

    // suggestions now show the pending-briefs card when a fresh pending one exists
    await db
      .updateTable("page_briefs")
      .set({ status: "pending", updatedAt: new Date().toISOString() })
      .where("id", "=", "pb1")
      .execute();
    const todos = await app.inject({ method: "GET", url: "/api/v1/todos" });
    const s = (todos.json() as { suggestions: { actionType: string; title: string }[] }).suggestions;
    expect(s.some((x) => x.actionType === "briefs" && x.title.includes("1 page brief"))).toBe(true);

    await app.close();
  });
});
