/**
 * astro-build.test.ts — the SHIPPED-ARTIFACT pixel oracle (Task 7, item D).
 *
 * parity-project.test.ts diffs the *assembled* index.html. But the artifact we ship is the
 * **Astro build** (semantic components + data-copy wired to content[]), which the assembled
 * reference doesn't exercise. This test proves the real build is 0-px faithful: it projects a
 * golden site, runs `astro build` on the emitted astro/ project, serves dist, and diffs the
 * built page vs the golden clone at 0-px @1440 + @390 via the SHARED pixelDiff oracle.
 *
 * Astro node_modules: the emitted project declares astro but ships no node_modules. We reuse a
 * shared astro@^4 install (default: the proven .mjs-era spike install) by symlink — mirroring
 * how the .mjs astro-diff relied on that project's node_modules. If no astro install is present
 * (e.g. a CI box without the spike), the test SKIPS with a clear message rather than failing —
 * the runnable scripts/astro-oracle.mjs performs the identical build+diff on demand. Only
 * speakeasy is exercised here to keep the astro build fast.
 */
import { describe, it, expect } from "vitest";
import { chromium, type Browser } from "playwright";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pixelDiff } from "./helpers/pixel.ts";
import { project } from "../src/project.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "..");
const REPO = path.resolve(PKG, "../..");
const SITE = "speakeasy";
const GOLDEN = path.join(dir, "golden", SITE);
const WIDTHS = [1440, 390] as const;

/** A shared astro@^4 node_modules to symlink into the emitted project (env override wins). */
function findAstroModules(): string | null {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(REPO, "page-clone-spike/out-project-page/astro/node_modules"),
    path.join(PKG, "node_modules"),
    path.join(REPO, "node_modules"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}

const ASTRO_MODULES = findAstroModules();

const MIME: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".woff": "font/woff", ".otf": "font/otf", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

async function shoot(browser: Browser, url: string, w: number): Promise<Buffer> {
  const p = await browser.newPage({ viewport: { width: w, height: 900 } });
  await p.route("**/*", (route) => {
    const u = route.request().url();
    if (u.includes("/assets/")) {
      const rel = decodeURIComponent(u.split("/assets/")[1].split("?")[0]);
      return route.fulfill({ path: path.join(GOLDEN, "assets", rel) }).catch(() => route.abort());
    }
    return route.continue();
  });
  await p.goto(url, { waitUntil: "networkidle" });
  await p.evaluate(async () => {
    const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const withTimeout = (pr: Promise<unknown>, ms: number) =>
      Promise.race([pr.catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
    if (document.fonts) await withTimeout(document.fonts.ready, 5000);
    for (const img of Array.from(document.querySelectorAll("img"))) {
      img.loading = "eager";
      if (!(img.complete && img.naturalWidth > 0)) await withTimeout(img.decode(), 3000);
    }
    window.scrollTo(0, document.body.scrollHeight);
    await withTimeout(raf(), 1000); await new Promise((r) => setTimeout(r, 300));
    window.scrollTo(0, 0);
    await withTimeout(raf(), 1000); await withTimeout(raf(), 1000);
  });
  await p.waitForTimeout(500);
  const buf = await p.screenshot({ fullPage: true });
  await p.close();
  return buf as Buffer;
}

describe("astro-build pixel oracle (shipped artifact)", () => {
  it.skipIf(!ASTRO_MODULES)(
    `${SITE}: built dist renders 0-px vs golden clone @1440+@390`,
    async () => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "astro-build-oracle-"));
      try {
        // 1. Project the golden (own build-based diff below, so noDiff here).
        await project({ dir: GOLDEN, out, trim: true, noDiff: true });
        const ASTRO = path.join(out, "astro");

        // 2. Symlink the shared astro node_modules into the emitted project.
        fs.symlinkSync(ASTRO_MODULES!, path.join(ASTRO, "node_modules"), "dir");

        // 3. astro build.
        const astroBin = fs.existsSync(path.join(ASTRO_MODULES!, ".bin/astro"))
          ? path.join(ASTRO_MODULES!, ".bin/astro")
          : path.join(ASTRO_MODULES!, "astro/astro.js");
        const build = spawnSync("node", [astroBin, "build"], { cwd: ASTRO, encoding: "utf8", env: process.env });
        expect(build.status, `astro build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);

        const DIST = path.join(ASTRO, "dist");
        expect(fs.existsSync(path.join(DIST, "index.html")), "dist/index.html not produced").toBe(true);

        // 4. Serve dist.
        const server = http.createServer((req, res) => {
          let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
          if (p === "/") p = "/index.html";
          const f = path.join(DIST, p);
          if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
          res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" });
          fs.createReadStream(f).pipe(res);
        });
        await new Promise<void>((r) => server.listen(0, () => r()));
        const port = (server.address() as import("node:net").AddressInfo).port;

        // 5 + 6. Diff built page vs golden clone at 0-px.
        const browser = await chromium.launch();
        try {
          for (const w of WIDTHS) {
            let r = { pct: -1, d: -1 };
            for (let attempt = 0; attempt < 3; attempt++) {
              const built = await shoot(browser, `http://127.0.0.1:${port}/`, w);
              const clone = await shoot(browser, "file://" + path.join(GOLDEN, "index.html"), w);
              r = await pixelDiff(browser, built, clone);
              if (r.pct === 0) break;
            }
            expect(r.pct, `${SITE} astro-build @${w}w drift ${r.pct}% (${r.d}px) after retries`).toBe(0);
          }
        } finally {
          await browser.close();
          server.close();
        }
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    },
    300_000,
  );

  it("astro-oracle is available as a runnable script when node_modules are present", () => {
    // Documents the fallback path: even when this test skips (no astro install in the harness),
    // scripts/astro-oracle.mjs performs the identical build+diff on demand.
    expect(fs.existsSync(path.join(PKG, "scripts/astro-oracle.mjs"))).toBe(true);
  });
});
