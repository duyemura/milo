import type { RunState } from "@milo/clone-engine";

/** Human, sentence-case one-liner for a run's live state. */
export function progressLabel(s: RunState): string {
  if (s.status === "built") return "Built";
  if (s.status === "failed") return "Build failed";
  if (s.status === "discovering") {
    return s.totalPages > 0 ? `Discovering pages — ${s.totalPages} found` : "Discovering pages…";
  }
  const where = s.current ? `${s.current.phase} ${s.current.route}` : "building";
  return `Building — ${s.pagesCompleted}/${s.totalPages || "?"} (${where})`;
}

/** 0–100 for a progress bar; 100 when built/failed. */
export function progressPercent(s: RunState): number {
  if (s.status === "built" || s.status === "failed") return 100;
  if (!s.totalPages) return s.status === "discovering" ? 5 : 10;
  return Math.min(95, Math.round((s.pagesCompleted / s.totalPages) * 100));
}
