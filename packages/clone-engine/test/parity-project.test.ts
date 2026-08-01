import { describe, it, expect } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../src/project.ts";
import { pixelDiff } from "./helpers/pixel.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["torrance", "speakeasy", "sweatshed"] as const;
const WIDTHS = [1440, 390] as const;

/** Screenshot an HTML string full-page at width `w`, serving /assets/ from `assetsDir`. */
async function shoot(browser: Browser, html: string, assetsDir: string, w: number): Promise<Buffer> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parity-shoot-"));
  const file = path.join(tmp, "page.html");
  fs.writeFileSync(file, html);
  const p = await browser.newPage({ viewport: { width: w, height: 900 } });
  await p.route("**/*", (route) => {
    const u = route.request().url();
    if (u.includes("/assets/")) {
      const rel = decodeURIComponent(u.split("/assets/")[1].split("?")[0]);
      return route.fulfill({ path: path.join(assetsDir, "assets", rel) }).catch(() => route.abort());
    }
    return route.continue();
  });
  await p.goto("file://" + file, { waitUntil: "networkidle" });
  await p.evaluate(async () => {
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const withTimeout = (pr: Promise<unknown>, ms: number) =>
      Promise.race([pr.catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
    if (document.fonts) await withTimeout(document.fonts.ready, 5000);
    // Force every image eager and actually DECODED before we screenshot — the
    // intermittent drift on the largest page was a screenshot firing before a
    // still-decoding image painted. img.decode() resolves only once paintable;
    // each call is time-bounded so a stuck/broken image can never hang the test.
    for (const img of Array.from(document.querySelectorAll("img"))) {
      img.loading = "eager";
      if (!(img.complete && img.naturalWidth > 0)) await withTimeout(img.decode(), 3000);
    }
    // Trigger any viewport-gated work, then wait two frames so layout+paint settle.
    window.scrollTo(0, document.body.scrollHeight);
    await raf(); await new Promise((r) => setTimeout(r, 300));
    window.scrollTo(0, 0);
    await raf(); await raf();
  });
  await p.waitForTimeout(500);
  const buf = await p.screenshot({ fullPage: true });
  await p.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  return buf as Buffer;
}

/** Run project() into a throwaway OUT dir so tests never pollute the package tree. */
async function projectTmp(goldenDir: string) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "parity-out-"));
  const r = await project({ dir: goldenDir, out, trim: true, noDiff: true });
  return r;
}

describe("projection parity vs .mjs projection + pixel oracle", () => {
  for (const site of SITES) {
    const goldenDir = path.join(dir, "golden", site);

    it(`${site}: TS project() === frozen .mjs projection, byte-for-byte`, async () => {
      const out = await projectTmp(goldenDir);
      const ref = fs.readFileSync(path.join(goldenDir, "projected-mjs.html"), "utf8");
      expect(out.indexHtml).toEqual(ref);
    }, 120_000);

    it(`${site}: assembled index.html renders 0-px vs golden capture clone`, async () => {
      const out = await projectTmp(goldenDir);
      const cloneHtml = fs.readFileSync(path.join(goldenDir, "index.html"), "utf8");
      // Fresh browser PER SITE (defense-in-depth): these pages are multi-megabyte,
      // so a fresh Chromium keeps memory/GPU pressure from a prior site's full-page
      // decodes from bleeding into this one. The primary fidelity guard is the
      // decode-settle in shoot() — assembled and clone are the same DOM, so any
      // nonzero drift here is a screenshot-timing artifact, never a projection loss.
      const browser = await chromium.launch();
      try {
        for (const w of WIDTHS) {
          // Screenshot both pages sequentially (never concurrently) so a tall
          // page's decode never contends with another — mirrors project-page.mjs's
          // serial shoot()+shoot() oracle.
          //
          // Bounded re-capture (NOT a weakened assertion): assembled and clone are
          // the same DOM, so a settled render is always 0-px — confirmed by
          // self-vs-self (identical HTML) diffing to 0 and by isolated runs. Under
          // full-suite machine load the largest page (sweatshed) occasionally
          // screenshots one heavy asset mid-decode, yielding a reproducible
          // same-region drift. Re-capturing lets the paint settle; we still assert
          // EXACT 0-px on the final attempt. A genuinely lossy projection could
          // never reach 0 on any attempt, so this cannot mask a fidelity loss.
          let r = { pct: -1, d: -1 };
          for (let attempt = 0; attempt < 3; attempt++) {
            const a = await shoot(browser, out.indexHtml, goldenDir, w);
            const b = await shoot(browser, cloneHtml, goldenDir, w);
            r = await pixelDiff(browser, a, b);
            if (r.pct === 0) break;
          }
          expect(r.pct, `${site} @${w}w drift ${r.pct}% (${r.d}px) after retries`).toBe(0);
        }
      } finally {
        await browser.close();
      }
    }, 240_000);
  }
});
