import { describe, expect, it } from "vitest";
import { testApp, testDb, fakeQueue, seedRegistry, testConfig } from "./helpers.ts";
import { deriveSuggestions } from "../src/chat/todos.ts";
import { buildApp } from "../src/server/app.ts";
import type { ChatFn } from "@milo/llm";

async function makeSite(db: Awaited<ReturnType<typeof testDb>>, status: string, stage: string) {
  await db
    .insertInto("sites")
    .values({
      id: "cs1",
      workspaceId: "ws1",
      companyId: "co1",
      seedType: "template",
      sourceUrl: "https://torrancetl.example.com",
      slug: "torrance-training-lab",
      status: status as never,
      stage: stage as never,
      active: 1,
      createdAt: new Date().toISOString(),
    })
    .execute();
}

describe("chat todos: suggestions", () => {
  it("suggests launching built sites and investigating failed jobs", async () => {
    const db = await testDb();
    await seedRegistry(db);
    await makeSite(db, "built", "building");
    await db
      .insertInto("jobs")
      .values({
        id: "j-fail",
        workspaceId: "ws1",
        companyId: "co1",
        siteId: "cs1",
        type: "build",
        status: "failed",
        payload: "{}",
        error: "engine exited 1",
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      })
      .execute();

    const suggestions = await deriveSuggestions(db);
    expect(suggestions.map((s) => s.actionType)).toContain("deploy-staging");
    expect(suggestions.map((s) => s.actionType)).toContain("investigate-job");
    expect(suggestions.find((s) => s.actionType === "deploy-staging")?.title).toContain("Iron Anchor");
  });
});

describe("chat route — rule fallback (no LLM key)", () => {
  it("launch <site> triggers the right job for a built site", async () => {
    const queue = fakeQueue();
    const { app, db } = await testApp(queue);
    await seedRegistry(db);
    await makeSite(db, "built", "building");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: { message: "launch torrance", history: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reply: string; effects: { ok: boolean; detail: string }[]; usedLlm: boolean };
    expect(body.usedLlm).toBe(false);
    expect(body.effects).toHaveLength(1);
    expect(body.effects[0]?.ok).toBe(true);
    expect(body.effects[0]?.detail).toContain("deploy-staging");
    expect(queue.added).toHaveLength(1);
    await app.close();
  });

  it("todo: <text> adds a manual todo for the actor", async () => {
    const queue = fakeQueue();
    const { app, db } = await testApp(queue);
    await seedRegistry(db);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: { message: "todo: call the Torrance owner about DNS", history: [] },
    });
    expect(res.statusCode).toBe(200);

    const todos = await app.inject({ method: "GET", url: "/api/v1/todos" });
    const body = todos.json() as { todos: { title: string; assignee: string }[] };
    expect(body.todos.some((t) => t.title.includes("Torrance owner"))).toBe(true);
    expect(body.todos[0]?.assignee).toBe("dev@pushpress.com");
    await app.close();
  });
});

describe("chat route — LLM path with injected fake", () => {
  it("executes actions parsed from the model's JSON", async () => {
    const queue = fakeQueue();
    const db = await testDb();
    await seedRegistry(db);
    await makeSite(db, "built", "building");
    const config = testConfig();
    const fakeChat: ChatFn = async () =>
      ({
        content: JSON.stringify({
          reply: "Publishing staging for Torrance now.",
          actions: [{ type: "triggerJob", args: { site: "torrance-training-lab", jobType: "deploy-staging" } }],
        }),
      }) as never;

    const app = await buildApp({ config, db, queue, chat: fakeChat });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      payload: { message: "please push torrance to staging", history: [] },
    });
    const body = res.json() as { reply: string; effects: { ok: boolean }[]; usedLlm: boolean };
    expect(body.usedLlm).toBe(true);
    expect(body.reply).toBe("Publishing staging for Torrance now.");
    expect(body.effects[0]?.ok).toBe(true);
    expect(queue.added).toHaveLength(1);
    await app.close();
  });
});
