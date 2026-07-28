import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { llmJson } from "../src/llm-json.ts";
import type { ChatFn } from "../src/llm-json.ts";

const Schema = z.object({ name: z.string(), count: z.number() });

describe("llmJson", () => {
  it("parses valid JSON on first try", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: '{"name":"a","count":2}' });
    const out = await llmJson(Schema, { chat, model: "m", messages: [{ role: "user", content: "go" }] });
    expect(out).toEqual({ name: "a", count: 2 });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("strips ```json fences before parsing", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: '```json\n{"name":"a","count":1}\n```' });
    const out = await llmJson(Schema, { chat, model: "m", messages: [{ role: "user", content: "go" }] });
    expect(out.count).toBe(1);
  });

  it("retries with the validation error fed back, then succeeds", async () => {
    const chat: ChatFn = vi.fn()
      .mockResolvedValueOnce({ content: '{"name":"a"}' })            // missing count
      .mockResolvedValueOnce({ content: '{"name":"a","count":5}' });
    const out = await llmJson(Schema, { chat, model: "m", messages: [{ role: "user", content: "go" }], maxRetries: 2 });
    expect(out.count).toBe(5);
    expect(chat).toHaveBeenCalledTimes(2);
    // second call must include a corrective message
    const secondCallMessages = (chat as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0] as { messages: unknown[] };
    expect(secondCallMessages.messages.length).toBeGreaterThan(1);
  });

  it("throws after exhausting retries", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: "not json" });
    await expect(
      llmJson(Schema, { chat, model: "m", messages: [{ role: "user", content: "go" }], maxRetries: 1 }),
    ).rejects.toThrow(/failed to produce valid/i);
  });
});
