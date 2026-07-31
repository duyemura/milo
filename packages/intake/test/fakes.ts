import type { PlacesClient } from "../src/places.ts";
import type { PageFetcher, FetchedPage } from "../src/crawl.ts";
import type { ChatFn, ChatMessage } from "@milo/llm";
import type { SocialScraper, SocialProfile } from "../src/social.ts";

export class FakePlacesClient implements PlacesClient {
  constructor(private result: unknown | null) {}
  async searchText(_query: string): Promise<unknown | null> { return this.result; }
  async getPhotoUri(photoName: string): Promise<string | null> {
    return `https://photos.google.com/fake/${photoName}`;
  }
}

export class FakePageFetcher implements PageFetcher {
  constructor(private byUrl: Record<string, string>, private throwUrls: string[] = []) {}
  async fetch(url: string): Promise<FetchedPage> {
    const resolved = this.resolve(url);
    if (this.throwUrls.includes(url) || this.throwUrls.includes(resolved.pathname)) {
      throw new Error(`HTTP 500 fetching ${url}`);
    }
    const html = this.byUrl[url] ?? this.byUrl[resolved.pathname] ?? "<html><body></body></html>";
    return { html, fetchMethod: "static" };
  }

  private resolve(url: string): URL {
    try {
      return new URL(url);
    } catch {
      return new URL(url, "http://dummy.test");
    }
  }
}

/** A ChatFn that returns queued responses in order (one per call). */
export function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

/** A ChatFn that records every call and returns queued responses in order. */
export function fakeChatWithCapture(responses: string[]) {
  let i = 0;
  const prompts: { model: string; messages: ChatMessage[] }[] = [];
  const chat: ChatFn = async (opts) => {
    prompts.push({ model: opts.model, messages: opts.messages });
    return { content: responses[Math.min(i++, responses.length - 1)] };
  };
  return { chat, prompts };
}

/** A SocialScraper that returns queued profiles in order for matching platforms. */
export function fakeSocialScraper(profiles: SocialProfile[]): SocialScraper {
  return {
    async scrape(_url: string, platform: string): Promise<SocialProfile | null> {
      return profiles.find((p) => p.platform === platform) ?? null;
    },
  };
}
