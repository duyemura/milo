/**
 * Typed child_process wrapper around the frozen page-clone-spike/page-clone.mjs.
 * Used by the CLI's `--engine=mjs` path to invoke the proven .mjs engine unchanged.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

// Anchored to the workspace layout: packages/clone-engine/src → repo root → page-clone-spike.
// If this package ever moves, update the "../" depth to match.
const SPIKE = path.resolve(import.meta.dirname, "../../../page-clone-spike");

export function mjsCapture(url: string, out: string): void {
  execFileSync("node", ["page-clone.mjs", "--url", url, "--out", out, "--no-verify"], { cwd: SPIKE, stdio: "inherit" });
}
