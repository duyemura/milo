/**
 * Typed child_process wrappers around the frozen page-clone-spike .mjs scripts.
 * Used by the CLI's `--engine=mjs` path to invoke the proven .mjs engines unchanged.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

// Anchored to the workspace layout: packages/clone-engine/src → repo root → page-clone-spike.
// If this package ever moves, update the "../" depth to match.
const SPIKE = path.resolve(import.meta.dirname, "../../../page-clone-spike");

export function mjsCapture(url: string, out: string): void {
  execFileSync("node", ["page-clone.mjs", "--url", url, "--out", out, "--no-verify"], { cwd: SPIKE, stdio: "inherit" });
}

export function mjsProject(dir: string, out: string, base: string, links?: string): void {
  // project-page.mjs expects --base as a quoted string and --links as a file path.
  // When links is omitted, project-page.mjs defaults to an empty link map ({}).
  const args = ["project-page.mjs", "--dir", dir, "--out", out, "--base", base, "--no-diff"];
  if (links) args.push("--links", links);
  execFileSync("node", args, { cwd: SPIKE, stdio: "inherit" });
}

export function mjsBuild(): void {
  // build-site.mjs is the whole-site orchestrator; it runs from the spike cwd.
  execFileSync("node", ["build-site.mjs"], { cwd: SPIKE, stdio: "inherit" });
}
