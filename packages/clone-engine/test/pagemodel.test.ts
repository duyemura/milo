/**
 * pagemodel.test.ts — unit tests for classifyPage + GOAL_OF_TYPE (subsystem D).
 *
 * Tests:
 *   - Each PageType is returned for representative routes
 *   - Goal derives correctly from type via GOAL_OF_TYPE
 *   - Route normalization (trailing slash, uppercase, no leading slash)
 *   - Catch-all pillar for unmapped routes
 */
import { describe, it, expect } from "vitest";
import { classifyPage, GOAL_OF_TYPE } from "../src/pagemodel.ts";
import type { PageType, PageGoal } from "../src/types.ts";

// ---------------------------------------------------------------------------
// GOAL_OF_TYPE map
// ---------------------------------------------------------------------------

describe("GOAL_OF_TYPE", () => {
  it("maps every PageType to a PageGoal", () => {
    const expected: Record<PageType, PageGoal> = {
      home: "orient",
      pillar: "inform",
      content: "engage",
      conversion: "convert",
      utility: "none",
    };
    for (const [type, goal] of Object.entries(expected) as [PageType, PageGoal][]) {
      expect(GOAL_OF_TYPE[type]).toBe(goal);
    }
  });
});

// ---------------------------------------------------------------------------
// home
// ---------------------------------------------------------------------------

describe("classifyPage — home", () => {
  it('returns home/orient for "/"', () => {
    expect(classifyPage("/")).toEqual({ type: "home", goal: "orient" });
  });

  it("normalizes empty string to home", () => {
    // An empty BASE in project.ts produces "/" as the route.
    expect(classifyPage("")).toEqual({ type: "home", goal: "orient" });
  });

  it("strips trailing slash before comparing home", () => {
    // "///" normalizes to "/" and matches home.
    expect(classifyPage("///")).toEqual({ type: "home", goal: "orient" });
  });
});

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

describe("classifyPage — content", () => {
  it("/blog matches content/engage", () => {
    expect(classifyPage("/blog")).toEqual({ type: "content", goal: "engage" });
  });

  it("/blog/my-post matches content/engage", () => {
    expect(classifyPage("/blog/my-post")).toEqual({ type: "content", goal: "engage" });
  });

  it("/news/2026-update matches content/engage", () => {
    expect(classifyPage("/news/2026-update")).toEqual({ type: "content", goal: "engage" });
  });

  it("/recipes/chicken-burrito matches content/engage", () => {
    expect(classifyPage("/recipes/chicken-burrito")).toEqual({ type: "content", goal: "engage" });
  });

  it("path with -spotlight matches content/engage", () => {
    expect(classifyPage("/member-spotlight-john")).toEqual({ type: "content", goal: "engage" });
  });

  it("path with -story matches content/engage", () => {
    expect(classifyPage("/athlete-story-jane")).toEqual({ type: "content", goal: "engage" });
  });
});

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

describe("classifyPage — conversion", () => {
  it("/pricing matches conversion/convert", () => {
    expect(classifyPage("/pricing")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/membership matches conversion/convert", () => {
    expect(classifyPage("/membership")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/membership/options matches conversion/convert", () => {
    expect(classifyPage("/membership/options")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/join matches conversion/convert", () => {
    expect(classifyPage("/join")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/join-now matches conversion/convert", () => {
    expect(classifyPage("/join-now")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/contact matches conversion/convert", () => {
    expect(classifyPage("/contact")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/contact-us matches conversion/convert", () => {
    expect(classifyPage("/contact-us")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/schedule matches conversion/convert", () => {
    expect(classifyPage("/schedule")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/book-a-class matches conversion/convert", () => {
    expect(classifyPage("/book-a-class")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/trial matches conversion/convert", () => {
    expect(classifyPage("/trial")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("/trial-offer matches conversion/convert", () => {
    expect(classifyPage("/trial-offer")).toEqual({ type: "conversion", goal: "convert" });
  });
});

// ---------------------------------------------------------------------------
// utility
// ---------------------------------------------------------------------------

describe("classifyPage — utility", () => {
  it("/privacy matches utility/none", () => {
    expect(classifyPage("/privacy")).toEqual({ type: "utility", goal: "none" });
  });

  it("/privacy-policy matches utility/none", () => {
    expect(classifyPage("/privacy-policy")).toEqual({ type: "utility", goal: "none" });
  });

  it("/terms matches utility/none", () => {
    expect(classifyPage("/terms")).toEqual({ type: "utility", goal: "none" });
  });

  it("/terms-of-service matches utility/none", () => {
    expect(classifyPage("/terms-of-service")).toEqual({ type: "utility", goal: "none" });
  });

  it("/legal matches utility/none", () => {
    expect(classifyPage("/legal")).toEqual({ type: "utility", goal: "none" });
  });

  it("/sitemap matches utility/none", () => {
    expect(classifyPage("/sitemap")).toEqual({ type: "utility", goal: "none" });
  });

  it("/sitemap.xml matches utility/none", () => {
    expect(classifyPage("/sitemap.xml")).toEqual({ type: "utility", goal: "none" });
  });

  it("/search matches utility/none", () => {
    expect(classifyPage("/search")).toEqual({ type: "utility", goal: "none" });
  });
});

// ---------------------------------------------------------------------------
// pillar (catch-all)
// ---------------------------------------------------------------------------

describe("classifyPage — pillar (catch-all)", () => {
  it("/about matches pillar/inform", () => {
    expect(classifyPage("/about")).toEqual({ type: "pillar", goal: "inform" });
  });

  it("/programs matches pillar/inform", () => {
    expect(classifyPage("/programs")).toEqual({ type: "pillar", goal: "inform" });
  });

  it("/coaches matches pillar/inform", () => {
    expect(classifyPage("/coaches")).toEqual({ type: "pillar", goal: "inform" });
  });

  it("/team matches pillar/inform", () => {
    expect(classifyPage("/team")).toEqual({ type: "pillar", goal: "inform" });
  });

  it("/nutrition matches pillar/inform", () => {
    expect(classifyPage("/nutrition")).toEqual({ type: "pillar", goal: "inform" });
  });

  it("/services matches pillar/inform", () => {
    expect(classifyPage("/services")).toEqual({ type: "pillar", goal: "inform" });
  });

  it("arbitrary unknown route matches pillar/inform", () => {
    expect(classifyPage("/something-random")).toEqual({ type: "pillar", goal: "inform" });
  });
});

// ---------------------------------------------------------------------------
// Route normalization
// ---------------------------------------------------------------------------

describe("classifyPage — route normalization", () => {
  it("handles routes without leading slash", () => {
    expect(classifyPage("about")).toEqual({ type: "pillar", goal: "inform" });
  });

  it("handles uppercase routes", () => {
    expect(classifyPage("/PRICING")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("handles trailing slashes", () => {
    expect(classifyPage("/pricing/")).toEqual({ type: "conversion", goal: "convert" });
  });

  it("handles mixed case + trailing slash", () => {
    expect(classifyPage("/Blog/Post/")).toEqual({ type: "content", goal: "engage" });
  });
});
