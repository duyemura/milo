import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harvestSites } from "../../../src/harvest/harvest.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");
const goldenDir = (name: string) => path.join(PKG, "test", "golden", name);

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

describe("harvest pipeline (end-to-end on goldens)", () => {
  it("harvests sections from >=2 goldens into a deduped library with popularity + emits templates", async () => {
    const result = await harvestSites(
      browser,
      [
        { site: "speakeasy", captureJson: path.join(goldenDir("speakeasy"), "capture.json") },
        { site: "sweatshed", captureJson: path.join(goldenDir("sweatshed"), "capture.json") },
      ],
      { residualThreshold: 0.7, popularityFloor: 1 },
    );

    // Some sections must survive classification into archetypes.
    expect(Object.keys(result.library.archetypes).length).toBeGreaterThan(0);
    // The report records every harvested candidate with its residual + verdict.
    expect(result.library.report.length).toBeGreaterThan(0);
    for (const row of result.library.report) {
      expect(typeof row.residual).toBe("number");
      expect(["adaptive", "reject"]).toContain(row.verdict);
    }
    // At least one adaptive archetype emits a template in the E-v1 shape.
    expect(result.emitted.length).toBeGreaterThan(0);
    const t = result.emitted[0].template;
    const filled: Record<string, string> = {};
    for (const k of Object.keys((t.slotSchema as unknown as { shape: Record<string, unknown> }).shape)) filled[k] = "X";
    const rt = t.render(filled, "T");
    expect(rt.html).toContain("data-section=");
  }, 240_000);
});
