import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { checkLayoutBreaks } from "../../src/buildreport/checks/layout-breaks.ts";
import { project } from "../../src/project.ts";
import { findAstroModules } from "../helpers/astro.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../..");   // packages/clone-engine
const REPO = path.resolve(PKG, "../../..");  // /Users/dan/pushpress

const ASTRO_MODULES = findAstroModules();

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { await browser?.close(); });

describe.skipIf(!ASTRO_MODULES)("checkLayoutBreaks", () => {
  it("no layout breaks on speakeasy (projected → layout check)", async () => {
    // Project the golden capture to a temp dir so renderSnapshot can build it
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "br-layout-"));
    await project({ dir: path.join(PKG, "test/golden/speakeasy"), out, trim: true, noDiff: true });
    const ctx = { route: "/", distHtmlPath: "", distHtml: "", distDir: "", siteDir: out };
    const result = await checkLayoutBreaks(ctx, browser, 1440);
    expect(result.issues.filter((i) => i.severity === "blocker")).toHaveLength(0);
    fs.rmSync(out, { recursive: true, force: true });
  }, 120_000);
});
