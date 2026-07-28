import type { PlacesClient } from "../src/places.ts";
import type { PageFetcher, FetchedPage } from "../src/crawl.ts";
import type { ChatFn } from "../src/llm-json.ts";

export class FakePlacesClient implements PlacesClient {
  constructor(private result: unknown | null) {}
  async searchText(_query: string): Promise<unknown | null> { return this.result; }
}

export class FakePageFetcher implements PageFetcher {
  constructor(private byUrl: Record<string, string>, private throwUrls: string[] = []) {}
  async fetch(url: string): Promise<FetchedPage> {
    if (this.throwUrls.includes(url) || this.throwUrls.includes(new URL(url).pathname)) {
      throw new Error(`HTTP 500 fetching ${url}`);
    }
    const html = this.byUrl[url] ?? this.byUrl[new URL(url).pathname] ?? "<html><body></body></html>";
    return { html, fetchMethod: "static" };
  }
}

/** A ChatFn that returns queued responses in order (one per call). */
export function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}
