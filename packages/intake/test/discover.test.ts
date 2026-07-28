import { describe, it, expect } from "vitest";
import { normalizeBaseUrl } from "../src/discover.ts";

describe("normalizeBaseUrl", () => {
  it("follows redirects and returns the final origin with trailing slash", async () => {
    const fetchLike = async (url: string) =>
      ({ url: "https://ironanchor.com/", ok: true, status: 200 }) as unknown as Response;
    expect(await normalizeBaseUrl("http://www.ironanchor.com", fetchLike)).toBe("https://ironanchor.com/");
  });

  it("falls back to the input origin when the fetch throws", async () => {
    const fetchLike = async () => { throw new Error("network"); };
    expect(await normalizeBaseUrl("https://gym.io/some/path", fetchLike)).toBe("https://gym.io/");
  });
});
