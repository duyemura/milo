import { describe, it, expect } from "vitest";
import { z } from "zod";
import { llmJson, type ChatFn } from "../src/llm-json.ts";

const NameSchema = z.object({ name: z.string() });

function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

describe("llmJson", () => {
  it("returns parsed data when the LLM emits valid JSON", async () => {
    const result = await llmJson(NameSchema, {
      chat: fakeChat([JSON.stringify({ name: "Iron Anchor" })]),
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({ name: "Iron Anchor" });
  });

  it("retries once on invalid JSON and succeeds", async () => {
    const chat = fakeChat(["not json", JSON.stringify({ name: "Iron Anchor" })]);
    const result = await llmJson(NameSchema, { chat, model: "test", messages: [] });
    expect(result).toEqual({ name: "Iron Anchor" });
  });

  it("retries once on Zod validation failure and succeeds", async () => {
    const chat = fakeChat([
      JSON.stringify({ name: 123 }),
      JSON.stringify({ name: "Iron Anchor" }),
    ]);
    const result = await llmJson(NameSchema, { chat, model: "test", messages: [] });
    expect(result).toEqual({ name: "Iron Anchor" });
  });

  it("throws after exhausting retries", async () => {
    const chat = fakeChat(["bad", "bad", "bad"]);
    await expect(
      llmJson(NameSchema, { chat, model: "test", messages: [], maxRetries: 2 }),
    ).rejects.toThrow(/LLM failed to produce valid JSON/);
  });

  it("strips markdown fences before parsing", async () => {
    const chat = fakeChat(["```json\n{\"name\": \"Iron Anchor\"}\n```"]);
    const result = await llmJson(NameSchema, { chat, model: "test", messages: [] });
    expect(result).toEqual({ name: "Iron Anchor" });
  });
});
