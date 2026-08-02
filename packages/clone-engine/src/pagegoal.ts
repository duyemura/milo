/**
 * pagegoal.ts — Subsystem F: evaluate whether a page achieved its declared goal.
 *
 * Maps a page's `data-goal` value (from the page model, subsystem D) against
 * a GA4 Ga4Rollup to produce a GoalReport: achieved + a 0-1 score + summary.
 *
 * The funnel the tracker emits:
 *   visited (page_view) → engaged (engaged_15s) → intent (intent_click) → converted (form_submit)
 *
 * Goal thresholds are intentionally conservative for early-stage sites.
 */
import fs from "node:fs";
import path from "node:path";
import type { PageGoal } from "./types.ts";
import { injectTracker, TRACKER_MARKER } from "@milo/measurement";

export { TRACKER_MARKER };

/**
 * Walk a built site directory and inject the engagement tracker script into
 * every `.html` file. Idempotent — files that already contain the marker are skipped.
 * Call this after `astro build` / `buildSiteAuto` to instrument a deployed site.
 */
export function injectTrackerIntoSite(siteDir: string): void {
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith(".html")) continue;
      const original = fs.readFileSync(abs, "utf8");
      const { html, changed } = injectTracker(original);
      if (changed) fs.writeFileSync(abs, html);
    }
  };
  walk(siteDir);
}

import type { Ga4Rollup } from "@milo/measurement";

export interface GoalReport {
  goal: PageGoal;
  achieved: boolean;
  /** Normalized 0-1 score — 0 = far from goal, 1 = exceeding goal. */
  score: number;
  metrics: Record<string, number>;
  summary: string;
}

/** Clamp a number to [0, 1]. */
function clamp(n: number): number { return Math.max(0, Math.min(1, n)); }

/**
 * Evaluate whether a page achieved its declared goal given a 28-day GA4 rollup.
 * Pure function — no I/O. Pair with `fetchGa4Rollup` from `@milo/measurement` to
 * get the rollup, then call this to interpret it.
 */
export function evaluateGoal(goal: PageGoal, rollup: Ga4Rollup): GoalReport {
  const { funnel, engagementRate, visitors } = rollup;

  switch (goal) {
    case "convert": {
      // A conversion page succeeds when visitors take action: form_submit (converted) OR
      // intent_click (intent). Threshold: intent rate >= 10% of visitors OR converted > 0.
      const intentRate = visitors > 0 ? funnel.intent / visitors : 0;
      const hasConversion = funnel.converted > 0;
      const achieved = hasConversion || intentRate >= 0.10;
      const score = clamp((funnel.converted > 0 ? 0.6 : 0) + Math.min(intentRate / 0.10, 1) * 0.4);
      const summary = achieved
        ? `Converting: ${funnel.converted} form submits, ${funnel.intent} intent clicks (${(intentRate * 100).toFixed(1)}% of visitors).`
        : `Not converting: ${funnel.intent} intent clicks (${(intentRate * 100).toFixed(1)}%), ${funnel.converted} submits. Target: ≥10% intent rate or ≥1 submit.`;
      return { goal, achieved, score, metrics: { intentRate, converted: funnel.converted }, summary };
    }

    case "inform": {
      // An informational page succeeds when visitors engage: engagement rate >= 40%
      // (engaged_15s / visited). High scroll depth is implicit in the engagement signal.
      const achieved = engagementRate >= 0.40;
      const score = clamp(engagementRate / 0.40);
      const summary = achieved
        ? `Engaging: ${(engagementRate * 100).toFixed(0)}% engagement rate (target ≥40%).`
        : `Low engagement: ${(engagementRate * 100).toFixed(0)}% engagement rate. Target: ≥40% of visitors engaged for ≥15s.`;
      return { goal, achieved, score, metrics: { engagementRate, engaged: funnel.engaged }, summary };
    }

    case "none":
    default: {
      return { goal, achieved: true, score: 1, metrics: {}, summary: "No measurable goal set for this page." };
    }
  }
}
