import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSite } from "../../src/buildreport/inspector.ts";
import { project } from "../../src/project.ts";
import { makeSiteDir, makeCaptureDir } from "./fixtures.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../..");
const REPO = path.resolve(PKG, "../../..");

if (!process.env.ASTRO_MODULES) {
  const candidate = path.join(REPO, "milo", "page-clone-spike/out-project-page/astro/node_modules");
  if (fs.existsSync(path.join(candidate, ".bin/astro"))) process.env.ASTRO_MODULES = candidate;
}
function findAstroModules(): string | null {
  const c = process.env.ASTRO_MODULES;
  return c && fs.existsSync(path.join(c, ".bin/astro")) ? c : null;
}
const ASTRO_MODULES = findAstroModules();

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { await browser?.close(); });
const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("inspectSite", () => {
  it("SHIP verdict on a clean projected site", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "br-inspect-"));
    cleanup.add(out);
    await project({ dir: path.join(PKG, "test/golden/speakeasy"), out, trim: true, noDiff: true });
    const report = await inspectSite({ siteDir: out, browser });
    expect(report.verdict).toBe("SHIP");
    expect(report.blockerCount).toBe(0);
    expect(typeof report.generatedAt).toBe("string");
  }, 240_000);

  it("NEEDS_FIXES verdict when a broken asset reference is in the source", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "br-needs-"));
    cleanup.add(out);
    await project({ dir: path.join(PKG, "test/golden/speakeasy"), out, trim: true, noDiff: true });
    // Inject a broken image into index.astro BEFORE the build — astro will include it in the output
    const idxPath = path.join(out, "astro", "src", "pages", "index.astro");
    const idx = fs.readFileSync(idxPath, "utf8");
    fs.writeFileSync(idxPath, idx.replace(/(<\/body>|<Fragment)/, '<img src="/broken-missing.png">$1'));
    const report = await inspectSite({ siteDir: out, browser });
    expect(report.verdict).toBe("NEEDS_FIXES");
    expect(report.issues.some((i) => i.kind === "broken-asset")).toBe(true);
  }, 240_000);
});
