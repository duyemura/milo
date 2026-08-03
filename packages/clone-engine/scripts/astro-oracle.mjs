/**
 * astro-oracle.mjs — the SHIPPED-ARTIFACT fidelity gate.
 *
 * The pixel oracle in parity-project.test.ts diffs the *assembled* index.html. But the
 * artifact we actually ship is the **Astro build** (semantic components + data-copy wired
 * to content[]), which the assembled reference does NOT exercise. This script proves the
 * real build is faithful:
 *
 *   1. project() a golden site → an emitted astro/ project (+ index.html + brand/site/labels).
 *   2. Make astro's node_modules available to that project (symlink a shared install —
 *      the emitted package.json declares astro but ships no node_modules).
 *   3. `astro build` → dist/.
 *   4. Serve dist over http; screenshot the built page.
 *   5. Screenshot the golden clone (index.html) with the same decode-settle discipline.
 *   6. Diff at 0-px @1440 + @390 via the SHARED pixelDiff oracle (same threshold/STRIP the
 *      parity test uses).
 *
 * Exit 0 iff both widths are exactly 0-px. Usage:
 *   node scripts/astro-oracle.mjs [--site speakeasy] [--astro-modules <path/to/node_modules>]
 *
 * `--astro-modules` defaults to the proven astro@4 install in the .mjs-era spike
 * (page-clone-spike/out-project-page/astro/node_modules) — mirroring how astro-diff.mjs
 * relied on that project's node_modules. Any astro@^4 node_modules works.
 */
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pixelDiff } from "../src/pixel.ts";
import { project } from "../src/project.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const REPO = path.resolve(PKG, "../..");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const SITE = arg("site", "speakeasy");
const GOLDEN = path.join(PKG, "test/golden", SITE);
const ASTRO_MODULES = path.resolve(
  arg("astro-modules", path.join(PKG, "node_modules")),
);
const WIDTHS = [1440, 390];

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".woff": "font/woff", ".otf": "font/otf", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

/** Screenshot a URL/file full-page at width `w`, fulfilling /assets/ from the golden clone. */
async function shoot(browser, url, w) {
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
    const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
    const withTimeout = (pr, ms) => Promise.race([pr.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
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
  return buf;
}

async function main() {
  if (!fs.existsSync(path.join(ASTRO_MODULES, ".bin/astro"))) {
    console.error(`astro-oracle: no astro install at ${ASTRO_MODULES}`);
    console.error("Pass --astro-modules <path> pointing at an astro@^4 node_modules directory.");
    process.exit(2);
  }

  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), `astro-oracle-${SITE}-`));
  console.log(`astro-oracle: site=${SITE}  out=${OUT}`);

  // 1. Project the golden (no diff — we run our own, stronger, build-based diff below).
  await project({ dir: GOLDEN, out: OUT, trim: true, noDiff: true });
  const ASTRO = path.join(OUT, "astro");

  // 2. Wire astro's node_modules into the emitted project (symlink a shared install).
  fs.symlinkSync(ASTRO_MODULES, path.join(ASTRO, "node_modules"), "dir");

  // 3. astro build.
  console.log("astro-oracle: building…");
  const build = spawnSync(path.join(ASTRO_MODULES, ".bin/astro"), ["build"], {
    cwd: ASTRO, stdio: "inherit", env: process.env,
  });
  if (build.status !== 0) {
    console.error(`astro-oracle: astro build failed (exit ${build.status})`);
    process.exit(1);
  }
  const DIST = path.join(ASTRO, "dist");
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("astro-oracle: dist/index.html not produced");
    process.exit(1);
  }

  // 4. Serve dist.
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(DIST, p);
    if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // 5 + 6. Diff the built page vs the golden clone at 0-px.
  const browser = await chromium.launch();
  let ok = true;
  try {
    for (const w of WIDTHS) {
      // Bounded re-capture: assembled/built and clone are the same DOM, so a settled render
      // is always 0-px. Under load the tallest page can screenshot one asset mid-decode; we
      // re-capture and assert EXACT 0-px on the final attempt (can't mask a real loss).
      let r = { pct: -1, d: -1, total: 0, dimMatch: false, ah: 0, bh: 0 };
      for (let attempt = 0; attempt < 3; attempt++) {
        const built = await shoot(browser, `http://127.0.0.1:${port}/`, w);
        const clone = await shoot(browser, "file://" + path.join(GOLDEN, "index.html"), w);
        r = await pixelDiff(browser, built, clone);
        if (r.pct === 0) break;
      }
      const verdict = r.pct === 0 ? "✓ LOSSLESS" : "✗ DRIFT";
      console.log(`  @${w}w  astro-build vs clone  drift ${r.pct}%  (${r.d}/${r.total})  dims ${r.dimMatch ? "match" : `MISMATCH ${r.ah}/${r.bh}`}  ${verdict}`);
      if (r.pct !== 0) ok = false;
    }
  } finally {
    await browser.close();
    server.close();
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  if (!ok) { console.error("astro-oracle: FAILED — built artifact drifted from the clone"); process.exit(1); }
  console.log("astro-oracle: PASS — shipped Astro build is 0-px faithful");
}

await main();
