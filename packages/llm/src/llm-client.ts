/**
 * LLM access layer — ported keeper from Milo v1 (websites/apps/api/src/ai/llm-client.ts).
 * OpenRouter-first with an Ollama fallback path; config is injected, never read
 * from framework plugins. All v2 LLM usage (intake extraction, generative copy
 * gaps) goes through this client. No direct provider SDKs.
 */

export interface LlmConfig {
  provider: "openrouter" | "ollama";
  openrouterBaseUrl?: string;
  openrouterApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaApiKey?: string;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  content: string;
  usage?: LlmUsage;
  latencyMs?: number;
  raw?: Record<string, unknown>;
}

export class LlmClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response: unknown,
  ) {
    super(message);
    this.name = "LlmClientError";
  }
}

/** Accumulates token usage across calls for build cost reporting. */
export class LlmCostAccumulator {
  private byModel = new Map<string, { prompt: number; completion: number; calls: number }>();

  track(promptTokens: number | undefined, completionTokens: number | undefined, model: string): void {
    const entry = this.byModel.get(model) ?? { prompt: 0, completion: 0, calls: 0 };
    entry.prompt += promptTokens ?? 0;
    entry.completion += completionTokens ?? 0;
    entry.calls += 1;
    this.byModel.set(model, entry);
  }

  summary(): Array<{ model: string; promptTokens: number; completionTokens: number; calls: number }> {
    return [...this.byModel.entries()].map(([model, e]) => ({
      model,
      promptTokens: e.prompt,
      completionTokens: e.completion,
      calls: e.calls,
    }));
  }

  reset(): void {
    this.byModel.clear();
  }
}

export const llmCostAccumulator = new LlmCostAccumulator();

export function buildOpenRouterUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  // Base URL may already include /v1 (e.g. https://openrouter.ai/api/v1)
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export function buildOllamaUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/chat`;
}

export async function parseResponse(response: Response): Promise<ChatResponse> {
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body.error as { message?: string }).message ?? response.statusText)
        : response.statusText;
    throw new LlmClientError(message, response.status, body);
  }
  if (!body) {
    throw new LlmClientError("Empty response from LLM API", response.status, body);
  }

  // Ollama /api/chat shape
  const message = body.message as { content?: string } | undefined;
  if (message?.content) {
    return {
      content: message.content,
      usage: body.eval_count
        ? {
            promptTokens: body.prompt_eval_count as number | undefined,
            completionTokens: body.eval_count as number | undefined,
            totalTokens:
              ((body.prompt_eval_count as number | undefined) ?? 0) + ((body.eval_count as number | undefined) ?? 0),
          }
        : undefined,
      raw: body,
    };
  }

  // OpenAI-compatible /v1/chat/completions shape
  const choices = body.choices as Array<{ message?: { content?: string } }> | undefined;
  const firstChoice = choices?.[0];
  if (firstChoice?.message?.content) {
    const usage = body.usage as
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined;
    return {
      content: firstChoice.message.content,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
      raw: body,
    };
  }

  throw new LlmClientError("Unrecognized LLM response shape", response.status, body);
}

const LLM_TIMEOUT_MS = 5 * 60 * 1000;

export async function chatCompletion(options: ChatOptions, config: LlmConfig): Promise<ChatResponse> {
  const start = performance.now();
  let response: ChatResponse;

  if (config.provider === "ollama") {
    if (!config.ollamaBaseUrl) throw new Error("ollamaBaseUrl required for provider=ollama");
    const fetchResponse = await fetch(buildOllamaUrl(config.ollamaBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.ollamaApiKey ? { Authorization: `Bearer ${config.ollamaApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: await buildOllamaMessages(options.messages),
        stream: false,
        options: { temperature: options.temperature ?? 0.7, num_predict: options.maxTokens },
        ...(options.jsonMode ? { format: "json" } : {}),
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    response = await parseResponse(fetchResponse);
  } else {
    if (!config.openrouterBaseUrl) throw new Error("openrouterBaseUrl required for provider=openrouter");
    const fetchResponse = await fetch(buildOpenRouterUrl(config.openrouterBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openrouterApiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
        ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    response = await parseResponse(fetchResponse);
  }

  if (response.usage) {
    llmCostAccumulator.track(response.usage.promptTokens, response.usage.completionTokens, options.model);
  }

  return { ...response, latencyMs: Math.round(performance.now() - start) };
}

async function buildOllamaMessages(
  messages: ChatMessage[],
): Promise<Array<{ role: string; content: string; images?: string[] }>> {
  return Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content === "string") {
        return { role: msg.role, content: msg.content };
      }
      let content = "";
      const images: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          content += part.text;
        } else if (part.type === "image_url") {
          const base64 = await urlToBase64(part.image_url.url);
          if (base64) images.push(base64);
        }
      }
      return { role: msg.role, content, ...(images.length ? { images } : {}) };
    }),
  );
}

async function urlToBase64(url: string): Promise<string | null> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return comma === -1 ? null : url.slice(comma + 1);
  }
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString("base64");
  } catch {
    return null;
  }
}
