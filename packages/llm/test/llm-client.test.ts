import { describe, expect, it } from "vitest";
import {
  buildOpenRouterUrl,
  buildOllamaUrl,
  parseResponse,
  LlmClientError,
  LlmCostAccumulator,
} from "../src/index.ts";

describe("buildOpenRouterUrl", () => {
  it("appends /v1/chat/completions to a bare base", () => {
    expect(buildOpenRouterUrl("https://openrouter.ai/api")).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
  it("does not duplicate /v1 when base already has it", () => {
    expect(buildOpenRouterUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
  it("strips a trailing slash", () => {
    expect(buildOpenRouterUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("buildOllamaUrl", () => {
  it("appends /api/chat", () => {
    expect(buildOllamaUrl("http://localhost:11434/")).toBe("http://localhost:11434/api/chat");
  });
});

describe("parseResponse", () => {
  it("parses OpenAI-compatible responses with usage", async () => {
    const res = new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    );
    const parsed = await parseResponse(res);
    expect(parsed.content).toBe("hello");
    expect(parsed.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("parses Ollama responses", async () => {
    const res = new Response(
      JSON.stringify({ message: { content: "hi" }, prompt_eval_count: 7, eval_count: 3 }),
      { status: 200 },
    );
    const parsed = await parseResponse(res);
    expect(parsed.content).toBe("hi");
    expect(parsed.usage?.totalTokens).toBe(10);
  });

  it("throws LlmClientError with provider message on error status", async () => {
    const res = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      statusText: "Too Many Requests",
    });
    await expect(parseResponse(res)).rejects.toThrowError(LlmClientError);
  });

  it("throws on unrecognized shapes", async () => {
    const res = new Response(JSON.stringify({ something: "else" }), { status: 200 });
    await expect(parseResponse(res)).rejects.toThrow("Unrecognized LLM response shape");
  });
});

describe("LlmCostAccumulator", () => {
  it("accumulates per model", () => {
    const acc = new LlmCostAccumulator();
    acc.track(10, 5, "openai/gpt-4o-mini");
    acc.track(20, 10, "openai/gpt-4o-mini");
    acc.track(1, 1, "anthropic/claude-sonnet-4-6");
    expect(acc.summary()).toEqual([
      { model: "openai/gpt-4o-mini", promptTokens: 30, completionTokens: 15, calls: 2 },
      { model: "anthropic/claude-sonnet-4-6", promptTokens: 1, completionTokens: 1, calls: 1 },
    ]);
  });
});
