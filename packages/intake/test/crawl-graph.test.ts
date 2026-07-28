import { describe, it, expect } from "vitest";
import { nextToCrawl, buildLinkMap } from "../src/crawl-graph.ts";

describe("nextToCrawl", () => {
  it("enqueues new non-UGC same-origin links up to the remaining budget", () => {
    const next = nextToCrawl({
      baseUrl: "https://g.com/",
      newLinks: ["https://g.com/team", "https://g.com/blog/x", "https://g.com/team", "https://other.com/a"],
      alreadyQueued: new Set(["https://g.com/"]),
      remaining: 5,
      includeUgc: false,
    });
    expect(next).toEqual(["https://g.com/team"]);   // dedup, UGC dropped, cross-origin dropped
  });

  it("respects the remaining budget", () => {
    const next = nextToCrawl({
      baseUrl: "https://g.com/",
      newLinks: ["https://g.com/a", "https://g.com/b", "https://g.com/c"],
      alreadyQueued: new Set(),
      remaining: 2,
      includeUgc: false,
    });
    expect(next).toHaveLength(2);
  });
});

describe("buildLinkMap", () => {
  it("records every same-origin url as a node, crawled flag + UGC flag, plus edges", () => {
    const map = buildLinkMap({
      baseUrl: "https://g.com/",
      discoveredAt: "2026-07-28T00:00:00Z",
      crawledSlugs: new Map([["https://g.com/", "index"], ["https://g.com/about", "about"]]),
      pageLinks: new Map([
        ["https://g.com/", ["https://g.com/about", "https://g.com/blog/post", "https://facebook.com/g"]],
        ["https://g.com/about", ["https://g.com/"]],
      ]),
    });
    const urls = map.nodes.map((n) => n.url).sort();
    expect(urls).toEqual(["https://g.com/", "https://g.com/about", "https://g.com/blog/post"]);
    expect(map.nodes.find((n) => n.url === "https://g.com/about")?.crawled).toBe(true);
    expect(map.nodes.find((n) => n.url === "https://g.com/blog/post")?.crawled).toBe(false);
    expect(map.nodes.find((n) => n.url === "https://g.com/blog/post")?.isUgc).toBe(true);
    expect(map.edges).toContainEqual({ from: "https://g.com/", to: "https://g.com/about" });
    // cross-origin links are never nodes or edges
    expect(map.edges.some((e) => e.to.includes("facebook"))).toBe(false);
  });

  it("ignores cross-origin from-keys — they never become nodes or edges", () => {
    const map = buildLinkMap({
      baseUrl: "https://g.com/",
      discoveredAt: "2026-07-28T00:00:00Z",
      crawledSlugs: new Map([["https://g.com/", "index"]]),
      pageLinks: new Map([
        ["https://g.com/", ["https://g.com/about"]],
        ["https://evil.com/x", ["https://g.com/", "https://evil.com/y"]], // stray cross-origin key
      ]),
    });
    expect(map.nodes.some((n) => n.url.includes("evil.com"))).toBe(false);
    expect(map.edges.some((e) => e.from.includes("evil.com"))).toBe(false);
  });
});
