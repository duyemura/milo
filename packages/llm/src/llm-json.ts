import type { z } from "zod";
import type { ChatMessage, ChatOptions, ChatResponse } from "./llm-client.ts";

/** Injectable chat function — real one is `(o) => chatCompletion(o, config)`. */
export type ChatFn = (options: ChatOptions) => Promise<ChatResponse>;

export interface LlmJsonOptions {
  chat: ChatFn;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
}

function stripFences(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Call the LLM in JSON mode and validate against `schema`. On parse/validation
 * failure, retry up to `maxRetries` times, feeding the error back so the model
 * can self-correct. Throws if all attempts fail.
 */
export async function llmJson<T extends z.ZodTypeAny>(
  schema: T,
  opts: LlmJsonOptions,
): Promise<z.infer<T>> {
  const maxRetries = opts.maxRetries ?? 2;
  const messages: ChatMessage[] = [...opts.messages];
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await opts.chat({
      model: opts.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.maxTokens,
      jsonMode: true,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(res.content));
    } catch {
      lastError = `Response was not valid JSON: ${res.content.slice(0, 200)}`;
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: `That was not valid JSON. ${lastError}. Return ONLY a JSON object.` });
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return result.data;

    lastError = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    messages.push({ role: "assistant", content: res.content });
    messages.push({
      role: "user",
      content: `The JSON failed schema validation with these errors: ${lastError}. Return a corrected JSON object.`,
    });
  }

  throw new Error(`LLM failed to produce valid JSON after ${maxRetries + 1} attempts: ${lastError}`);
}
