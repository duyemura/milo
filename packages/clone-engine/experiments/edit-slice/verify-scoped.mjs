/**
 * verify-scoped.mjs — THE safety mechanism of the edit bet.
 *
 * An edit "looks right" is not proof. This proves an edit is SAFE by building the real Astro
 * artifact before + after the edit, screenshotting both full pages, and pixel-diffing under a
 * scope that says exactly which pixels were ALLOWED to change:
 *
 *   editCopy → the ONLY pixels allowed to change are inside the edited element's bounding box.
 *              Everything outside that box must be 0-px. (Nothing else in the page moved.)
 *   setBrand → the ONLY pixels allowed to change are ones whose BEFORE color matched the old
 *              slot color or whose AFTER color matches the new slot color (the recolor). Any
 *              changed pixel that matches neither is "collateral" and must be ~0.
 *
 * The verification is designed to FAIL: if an edit reflowed an unrelated section or corrupted
 * layout, the out-of-scope pixel count is non-zero and the check reports UNSAFE.
 *
 * Builds reuse the astro-oracle approach from test/astro-build.test.ts: symlink a shared
 * astro node_modules into the emitted project and run `astro build`, then serve dist.
 */
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN_ASSETS = path.join(PKG, "test/golden/speakeasy/assets");

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".woff": "font/woff", ".otf": "font/otf", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

function findAstroModules() {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(PKG, "node_modules"),
    path.join(PKG, "node_modules"),
    path.join(REPO, "node_modules"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}

/** Build the emitted astro/ project in `outDir` and return the dist path. */
export function astroBuild(outDir) {
  const astroDir = path.join(outDir, "astro");
  const mods = findAstroModules();
  if (!mods) throw new Error("no astro node_modules found (set ASTRO_MODULES)");
  const link = path.join(astroDir, "node_modules");
  if (!fs.existsSync(link)) fs.symlinkSync(mods, link, "dir");
  const astroBin = fs.existsSync(path.join(mods, ".bin/astro"))
    ? path.join(mods, ".bin/astro")
    : path.join(mods, "astro/astro.js");
  const build = spawnSync("node", [astroBin, "build"], { cwd: astroDir, encoding: "utf8", env: process.env });
  if (build.status !== 0) throw new Error(`astro build failed:\n${build.stdout}\n${build.stderr}`);
  const dist = path.join(astroDir, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("dist/index.html not produced");
  return dist;
}

function serveDist(dist) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(dist, p);
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return server;
}

/**
 * Load a built page, settle fonts/images/scroll, and return { png, rect } where rect is the
 * full-page bounding box of `selector` (or null if not requested / not found). Assets under
 * /assets/ are fulfilled from the golden capture (the clone rehosts them locally).
 */
async function shootAndMeasure(browser, url, width, selector) {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await p.route("**/*", (route) => {
    const u = route.request().url();
    if (u.includes("/assets/")) {
      const rel = decodeURIComponent(u.split("/assets/")[1].split("?")[0]);
      return route.fulfill({ path: path.join(GOLDEN_ASSETS, rel) }).catch(() => route.abort());
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
  await p.waitForTimeout(400);

  // Measure the edited element's rect AND its owning section's rect (document coords). We report
  // both scopes: the ELEMENT box is the strict test; the SECTION box is site.json's edit unit and
  // is robust to the element's own ink overflowing its layout box (large display fonts do this).
  let rect = null, sectionRect = null;
  if (selector) {
    const m = await p.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
      const sec = el.closest("[data-section]");
      return { rect: box(el), sectionRect: sec ? box(sec) : null };
    }, selector);
    rect = m?.rect ?? null;
    sectionRect = m?.sectionRect ?? null;
  }
  const png = await p.screenshot({ fullPage: true });
  await p.close();
  return { png, rect, sectionRect };
}

/**
 * Decode two PNGs + run a per-pixel classifier in a headless canvas. `mode` selects the scope.
 * Returns { total, changed, inScope, outScope, width, height } where inScope = changed pixels
 * that were ALLOWED to change, outScope = changed pixels that were NOT (the danger number).
 */
async function classifyDiff(browser, aPng, bPng, mode, params) {
  const dp = await browser.newPage();
  try {
    return await dp.evaluate(async ([aB64, bB64, m, pr]) => {
      const load = (s) => new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("decode failed"));
        i.src = "data:image/png;base64," + s;
      });
      const [ia, ib] = await Promise.all([load(aB64), load(bB64)]);
      const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(ia, 0, 0); const A = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h); ctx.drawImage(ib, 0, 0); const B = ctx.getImageData(0, 0, w, h).data;

      const THRESH = 8; // same per-channel threshold as the engine's pixelDiff
      let changed = 0, inScope = 0, outScope = 0;

      // colorNear: is [r,g,b] within `tol` (per channel) of target [tr,tg,tb]?
      const near = (r, g, b, t, tol) => Math.abs(r - t[0]) <= tol && Math.abs(g - t[1]) <= tol && Math.abs(b - t[2]) <= tol;
      // The recolor's channel-delta DIRECTION (new - old), normalized to signs. Any pixel that
      // was the old brand color at ANY opacity over ANY backdrop shifts along this vector; a
      // pixel changed for an unrelated reason will not track all three signs. This catches the
      // translucent brand fills + edges a solid old/new match misses (the honest recolor mask).
      let dirR = 0, dirG = 0, dirB = 0;
      if (m === "recolor") {
        dirR = Math.sign(pr.newRgb[0] - pr.oldRgb[0]);
        dirG = Math.sign(pr.newRgb[1] - pr.oldRgb[1]);
        dirB = Math.sign(pr.newRgb[2] - pr.oldRgb[2]);
      }
      const MIN = pr && pr.dirMin != null ? pr.dirMin : 6; // min per-channel shift to count as directional

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const sr = B[i] - A[i], sg = B[i + 1] - A[i + 1], sb = B[i + 2] - A[i + 2];
          if (Math.abs(sr) <= THRESH && Math.abs(sg) <= THRESH && Math.abs(sb) <= THRESH) continue;
          changed++;
          let allowed = false;
          if (m === "box") {
            const { x0, y0, x1, y1 } = pr;
            allowed = x >= x0 && x < x1 && y >= y0 && y < y1;
          } else if (m === "recolor") {
            // (a) solid fill: before≈old OR after≈new. (b) translucent/edge: the color moved
            // ALONG the recolor vector — each channel that has a defined direction shifted that
            // way (with a meaningful magnitude on at least one), and no channel moved opposite.
            const solid = near(A[i], A[i + 1], A[i + 2], pr.oldRgb, pr.tol) || near(B[i], B[i + 1], B[i + 2], pr.newRgb, pr.tol);
            const okR = dirR === 0 ? true : (dirR > 0 ? sr >= 0 : sr <= 0);
            const okG = dirG === 0 ? true : (dirG > 0 ? sg >= 0 : sg <= 0);
            const okB = dirB === 0 ? true : (dirB > 0 ? sb >= 0 : sb <= 0);
            const mag = (dirR && Math.abs(sr) >= MIN) || (dirG && Math.abs(sg) >= MIN) || (dirB && Math.abs(sb) >= MIN);
            allowed = solid || (okR && okG && okB && mag);
          }
          if (allowed) inScope++; else outScope++;
        }
      }
      return { total: w * h, changed, inScope, outScope, width: w, height: h };
    }, [aPng.toString("base64"), bPng.toString("base64"), mode, params]);
  } finally {
    await dp.close();
  }
}

/**
 * verifyScoped — build before/after, screenshot, scoped-diff.
 *
 * @param outDir       projected out dir (already edited)
 * @param before       { dist } snapshot from snapshotBefore(outDir) (the pre-edit build)
 * @param editKind     "editCopy" | "setBrand"
 * @param opts.selector (editCopy) CSS selector of the edited element
 * @param opts.oldHex/newHex (setBrand) the recolor
 * @param opts.width   viewport width (default 1440)
 * @param opts.pad     (editCopy) box padding in px to absorb AA at the element edge (default 4)
 */
export async function verifyScoped(outDir, before, editKind, opts = {}) {
  const width = opts.width ?? 1440;
  const afterDist = astroBuild(outDir);
  const beforeServer = serveDist(before.dist);
  const afterServer = serveDist(afterDist);
  await new Promise((r) => beforeServer.listen(0, r));
  await new Promise((r) => afterServer.listen(0, r));
  const bPort = beforeServer.address().port;
  const aPort = afterServer.address().port;

  const browser = await chromium.launch();
  try {
    const selector = editKind === "editCopy" ? opts.selector : null;
    // Screenshot after (measure the edited element on the after build) then before.
    const after = await shootAndMeasure(browser, `http://127.0.0.1:${aPort}/`, width, selector);
    const beforeShot = await shootAndMeasure(browser, `http://127.0.0.1:${bPort}/`, width, selector);

    if (editKind === "editCopy") {
      if (opts.saveDir) saveShots(opts.saveDir, opts.label ?? editKind, beforeShot.png, after.png);
      const pad = opts.pad ?? 4;
      // Build a padded union box (before ∪ after) for a given rect-pair.
      const mkBox = (rs) => {
        const r = rs.filter(Boolean);
        if (r.length === 0) return null;
        return {
          x0: Math.max(0, Math.floor(Math.min(...r.map((b) => b.x)) - pad)),
          y0: Math.max(0, Math.floor(Math.min(...r.map((b) => b.y)) - pad)),
          x1: Math.ceil(Math.max(...r.map((b) => b.x + b.w)) + pad),
          y1: Math.ceil(Math.max(...r.map((b) => b.y + b.h)) + pad),
        };
      };
      const elBox = mkBox([after.rect, beforeShot.rect]);
      const secBox = mkBox([after.sectionRect, beforeShot.sectionRect]);
      if (!elBox) throw new Error(`verifyScoped: selector matched nothing: ${opts.selector}`);
      // Strict ELEMENT-box scope (exposes intra-element ink overflow) …
      const elem = await classifyDiff(browser, beforeShot.png, after.png, "box", elBox);
      // … and the semantically-correct SECTION-box scope (site.json's edit unit).
      const section = secBox ? await classifyDiff(browser, beforeShot.png, after.png, "box", secBox) : null;
      const scoped = section ?? elem;
      return {
        editKind, width,
        elementBox: elBox, sectionBox: secBox,
        element: elem, section,
        changed: scoped.changed, inScope: scoped.inScope, outScope: scoped.outScope,
        safe: scoped.outScope === 0, intended: scoped.inScope > 0,
      };
    }

    // setBrand
    const hex = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const params = { oldRgb: hex(opts.oldHex), newRgb: hex(opts.newHex), tol: opts.tol ?? 24 };
    if (opts.saveDir) saveShots(opts.saveDir, opts.label ?? editKind, beforeShot.png, after.png);
    const res = await classifyDiff(browser, beforeShot.png, after.png, "recolor", params);
    return { editKind, width, oldHex: opts.oldHex, newHex: opts.newHex, ...res, safe: res.outScope === 0, intended: res.inScope > 0 };
  } finally {
    await browser.close();
    beforeServer.close();
    afterServer.close();
  }
}

function saveShots(dir, label, beforePng, afterPng) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${label}-before.png`), beforePng);
  fs.writeFileSync(path.join(dir, `${label}-after.png`), afterPng);
}

/** Build the CURRENT (pre-edit) state and stash its dist so verifyScoped can diff against it. */
export function snapshotBefore(outDir) {
  const dist = astroBuild(outDir);
  // Copy dist aside so the after-build (same path) doesn't clobber it.
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), "edit-slice-before-"));
  fs.cpSync(dist, stash, { recursive: true });
  return { dist: stash };
}
