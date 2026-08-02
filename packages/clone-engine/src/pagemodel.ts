/**
 * pagemodel.ts — page-type taxonomy + goal classifier (Plan 3, Subsystem D).
 *
 * Pure function — no file I/O, no browser. Classify a route into a PageType and
 * PageGoal using heuristic route-pattern matching.
 *
 * Matching order (first match wins):
 *   1. Exact "/"              → home / orient
 *   2. Content patterns       → content / engage
 *   3. Conversion patterns    → conversion / convert
 *   4. Utility patterns       → utility / none
 *   5. Catch-all              → pillar / inform
 *
 * An LLM refinement pass (subsystem F) may override `goal` per-page in future;
 * this heuristic is the correct v1 implementation — no LLM call here.
 */
import type { PageType, PageGoal } from "./types.ts";

export type { PageType, PageGoal };

/** Default goal for each PageType. Stable contract — F reads this mapping. */
export const GOAL_OF_TYPE: Record<PageType, PageGoal> = {
  home: "orient",
  pillar: "inform",
  content: "engage",
  conversion: "convert",
  utility: "none",
};

/**
 * Classify a route into { type, goal } using heuristic pattern matching.
 *
 * `route` may be any form: "/about", "about/", "/blog/my-post", "/", "pricing".
 * Normalization (lowercase, strip trailing slash, ensure leading slash) is applied
 * before matching so callers need not pre-sanitize.
 */
export function classifyPage(route: string): { type: PageType; goal: PageGoal } {
  // Normalize: lowercase, strip trailing slashes, ensure leading slash.
  const r = ("/" + route.toLowerCase().replace(/^\/+|\/+$/g, "")).replace(/\/+/g, "/");

  // 1. Home
  if (r === "/") return make("home");

  // 2. Content: blog, news, spotlights, stories, recipes (editorial / UGC)
  if (
    r.startsWith("/blog") ||
    r.startsWith("/news") ||
    r.startsWith("/recipes") ||
    r.includes("-spotlight") ||
    r.includes("-story")
  ) return make("content");

  // 3. Conversion: act pages (pricing, membership, join, trial, contact, schedule, book)
  if (
    r.startsWith("/pricing") ||
    r.startsWith("/membership") ||
    r.startsWith("/join") ||
    r.startsWith("/contact") ||
    r.startsWith("/schedule") ||
    r.startsWith("/book") ||
    r.startsWith("/trial")
  ) return make("conversion");

  // 4. Utility: legal / nav / infrastructure
  if (
    r.startsWith("/privacy") ||
    r.startsWith("/terms") ||
    r.startsWith("/legal") ||
    r.startsWith("/sitemap") ||
    r.startsWith("/search")
  ) return make("utility");

  // 5. Catch-all: pillar (about, programs, coaches, services, team, nutrition, etc.)
  return make("pillar");
}

function make(type: PageType): { type: PageType; goal: PageGoal } {
  return { type, goal: GOAL_OF_TYPE[type] };
}
