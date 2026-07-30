import type { ChatFn } from "@milo/llm";

/** A ChatFn that returns queued responses in order (one per call). */
export function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}
