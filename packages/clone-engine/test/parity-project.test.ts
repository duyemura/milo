import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../src/project.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["torrance", "speakeasy", "sweatshed"] as const;
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

describe("projection parity vs golden", () => {
  for (const site of SITES) {
    it(`${site}: TS project() reproduces golden index.html byte-for-byte`, async () => {
      const goldenDir = path.join(dir, "golden", site);
      const out = await project({ dir: goldenDir, trim: true }); // returns { indexHtml, ... }
      const golden = fs.readFileSync(path.join(goldenDir, "index.html"), "utf8");
      // Plan-1 port must reproduce current output EXACTLY (no features added yet).
      expect(out.indexHtml).toEqual(golden);
    });
  }
});
