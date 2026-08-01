/**
 * Test oracle = production oracle. Re-exported from src/pixel.ts so the test and
 * project.ts can never drift on threshold, STRIP size, or pct rounding.
 */
export { pixelDiff, type PixelDiffResult } from "../../src/pixel.ts";
