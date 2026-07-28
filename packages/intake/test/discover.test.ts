import { describe, it, expect } from "vitest";
import { normalizeBaseUrl, isUgc, isNonHtml, slugFor, priorityFor } from "../src/discover.ts";

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

describe("isUgc", () => {
  it("flags blog/news/date/wordpress patterns", () => {
    expect(isUgc("https://g.com/blog/how-to")).toBe(true);
    expect(isUgc("https://g.com/2024/03/post")).toBe(true);
    expect(isUgc("https://g.com/?p=42")).toBe(true);
    expect(isUgc("https://g.com/wod/monday")).toBe(true);
  });
  it("does not flag core pages", () => {
    expect(isUgc("https://g.com/about")).toBe(false);
    expect(isUgc("https://g.com/pricing")).toBe(false);
  });
});

describe("isNonHtml", () => {
  it("flags binary extensions", () => {
    expect(isNonHtml("https://g.com/menu.pdf")).toBe(true);
    expect(isNonHtml("https://g.com/hero.jpg")).toBe(true);
    expect(isNonHtml("https://g.com/promo.mp4")).toBe(true);
  });
  it("passes html-ish urls", () => {
    expect(isNonHtml("https://g.com/coaches")).toBe(false);
    expect(isNonHtml("https://g.com/")).toBe(false);
  });
});

describe("slugFor", () => {
  it("derives a slug from the path, homepage -> index", () => {
    expect(slugFor("https://g.com/", "https://g.com/")).toBe("index");
    expect(slugFor("https://g.com/our-coaches/", "https://g.com/")).toBe("our-coaches");
    expect(slugFor("https://g.com/programs/crossfit", "https://g.com/")).toBe("programs-crossfit");
  });
});

describe("priorityFor", () => {
  it("ranks core pages ahead of misc", () => {
    expect(priorityFor("https://g.com/")).toBe(1);
    expect(priorityFor("https://g.com/about")).toBe(2);
    expect(priorityFor("https://g.com/coaches")).toBe(3);
    expect(priorityFor("https://g.com/programs")).toBe(4);
    expect(priorityFor("https://g.com/pricing")).toBe(5);
    expect(priorityFor("https://g.com/random-thing")).toBe(9);
  });
});
