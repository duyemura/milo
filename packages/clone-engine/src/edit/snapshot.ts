/**
 * snapshot.ts — deterministic per-section render capture for the edit verifier.
 *
 * The verifier proves an edit landed AND nothing else broke by comparing a section's
 * rendered pixels before vs after. The unit of comparison is a SECTION's OWN bounding
 * box (position-independent): we crop each section by the box it occupies in ITS OWN
 * render, so a section that merely reflowed/shifted down still crops to identical pixels.
 *
 * A snapshot is built from the REAL shipped artifact — `astro build` → serve dist →
 * screenshot — reusing the exact plumbing the astro-oracle uses (symlink a shared astro
 * node_modules, serve dist over http, fulfill /assets/ from the golden capture).
 *
 * ANTI-FLAKE (hard requirement — a build-report job runs captures concurrently):
 *   - full decode-settle discipline (fonts.ready + img.decode() + double-rAF, all bounded)
 *     identical to the pixel oracle's shoot(), so a settled render is deterministic.
 *   - bounded RE-CAPTURE: a fidelity verifier cannot tolerate a frame that raced an
 *     asset mid-decode. We re-shoot until two consecutive full-page screenshots are
 *     byte-identical (the render has settled), bounded to a few attempts. Under browser
 *     contention the first frame may differ; the settled frame is the one we crop from.
 */
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import type { SiteRef } from "./types.ts";
import type { SiteManifest } from "../types.ts";
import { findAstroModules as sharedFindAstroModules, findAstroJs } from "../astro.ts";

const MIME: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2",
  ".woff": "font/woff", ".otf": "font/otf", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

/** A rendered section: its own bounding box (document coords) + a cropped PNG of that box. */
export interface SectionRender {
  /** data-component value (== ManifestSection.name). */
  name: string;
  /** data-section role (content sections only), or null for Navbar/Footer. */
  role: string | null;
  /** Bounding box in document coordinates at the snapshot width. */
  box: { x: number; y: number; w: number; h: number };
  /** PNG of just this section's box (position-independent crop). */
  cropPng: Buffer;
}

/** A full before/after render snapshot at one viewport width. */
export interface RenderSnapshot {
  width: number;
  /** Each section keyed by its data-component name. */
  sections: Map<string, SectionRender>;
  /** Full-page screenshot (used for render-sanity + debugging). */
  fullPng: Buffer;
  /** The section names in DOM order (structural comparison). */
  order: string[];
  /**
   * Whether the render deterministically SETTLED: two consecutive full-page frames were
   * byte-identical within the attempt budget. When false, the fullPng may reflect a frame that
   * raced an asset mid-decode — the verifier surfaces this so the apply-loop can distinguish a
   * flaky render from a real diff instead of retrying blind.
   */
  settled: boolean;
  /**
   * Boxes of any extra selectors requested via opts.extraSelectors, in document coords. Keyed by
   * the selector string; absent from the map if the selector matched nothing. Used by the verifier
   * to sub-scope an edited section to its edited ELEMENT box (intra-section collateral check).
   */
  extraBoxes: Map<string, { x: number; y: number; w: number; h: number }>;
}

/** Locate a shared astro@^4 node_modules to symlink into the emitted project. */
// Use the shared findAstroModules from src/astro.ts (which checks ASTRO_MODULES env + engine node_modules).
const findAstroModules = sharedFindAstroModules;

/**
 * Build the emitted astro/ project in `site.dir` and return the fresh dist path.
 * The dist is copied aside to a unique temp dir so a later re-build (same in-place
 * dist path) can never clobber an earlier snapshot's dist.
 */
export function astroBuild(site: SiteRef): string {
  const astroDir = path.join(site.dir, "astro");
  const astroJs = findAstroJs();
  const mods = findAstroModules();
  if (!mods) throw new Error("snapshot: no astro node_modules found (set ASTRO_MODULES)");
  // Symlink engine's node_modules into the per-page project so astro/config resolves.
  const link = path.join(astroDir, "node_modules");
  if (!fs.existsSync(link)) fs.symlinkSync(mods, link, "dir");
  const build = spawnSync("node", [astroJs, "build"], { cwd: astroDir, encoding: "utf8", env: process.env });
  if (build.status !== 0) throw new Error(`snapshot: astro build failed:\n${build.stdout}\n${build.stderr}`);
  const dist = path.join(astroDir, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("snapshot: dist/index.html not produced");
  // Copy dist aside so the after-build (same in-place path) doesn't clobber a prior snapshot.
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), "edit-verify-dist-"));
  fs.cpSync(dist, stash, { recursive: true });
  return stash;
}

/** Serve a dist dir over http; /assets/ is served from within dist (astro copies public/assets → dist/assets). */
function serveDist(dist: string, assetsFallback: string | null): http.Server {
  return http.createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    let f = path.join(dist, p);
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      // Fall back to the golden capture's assets/ for any /assets/ the build didn't inline.
      if (assetsFallback && p.includes("/assets/")) {
        const rel = decodeURIComponent(p.split("/assets/")[1]);
        const alt = path.join(assetsFallback, rel);
        if (fs.existsSync(alt) && !fs.statSync(alt).isDirectory()) f = alt;
        else { res.writeHead(404); return res.end("nf"); }
      } else { res.writeHead(404); return res.end("nf"); }
    }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
}

/**
 * Load a served page, settle it deterministically, then take a full-page screenshot.
 * Re-shoots until two consecutive screenshots are byte-identical (settled) or the attempt
 * budget is exhausted — under concurrent browser load the first frame can race an asset
 * mid-decode; the settled frame is the honest render. Returns the frame + whether it settled
 * (two consecutive identical frames were observed within the budget).
 */
async function shootSettled(browser: Browser, url: string, width: number, assetsFallback: string | null): Promise<{ png: Buffer; settled: boolean }> {
  const settle = async (): Promise<Buffer> => {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      if (assetsFallback) {
        await p.route("**/*", (route) => {
          const u = route.request().url();
          if (u.includes("/assets/")) {
            const rel = decodeURIComponent(u.split("/assets/")[1].split("?")[0]);
            const alt = path.join(assetsFallback, rel);
            if (fs.existsSync(alt)) return route.fulfill({ path: alt }).catch(() => route.abort());
          }
          return route.continue();
        });
      }
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
      await p.waitForTimeout(400);
      return (await p.screenshot({ fullPage: true })) as Buffer;
    } finally {
      await p.close();
    }
  };
  // Bounded re-capture: shoot until two consecutive frames are byte-identical (render settled).
  let prev = await settle();
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await settle();
    if (next.equals(prev)) return { png: next, settled: true }; // two identical frames → settled
    prev = next;
  }
  return { png: prev, settled: false }; // budget exhausted without two identical frames
}

/**
 * Measure every section's own bounding box (document coords) on a settled page. A section is
 * any element carrying data-component; we key by that value. role comes from data-section
 * (content sections) or null (Navbar/Footer). Boxes are read after the same settle discipline.
 */
async function measureSections(
  browser: Browser,
  url: string,
  width: number,
  assetsFallback: string | null,
): Promise<Array<{ name: string; role: string | null; box: { x: number; y: number; w: number; h: number } }>> {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    if (assetsFallback) {
      await p.route("**/*", (route) => {
        const u = route.request().url();
        if (u.includes("/assets/")) {
          const rel = decodeURIComponent(u.split("/assets/")[1].split("?")[0]);
          const alt = path.join(assetsFallback, rel);
          if (fs.existsSync(alt)) return route.fulfill({ path: alt }).catch(() => route.abort());
        }
        return route.continue();
      });
    }
    await p.goto(url, { waitUntil: "networkidle" });
    await p.evaluate(async () => {
      const withTimeout = (pr: Promise<unknown>, ms: number) =>
        Promise.race([pr.catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
      if (document.fonts) await withTimeout(document.fonts.ready, 5000);
      for (const img of Array.from(document.querySelectorAll("img"))) {
        img.loading = "eager";
        if (!(img.complete && img.naturalWidth > 0)) await withTimeout(img.decode(), 3000);
      }
    });
    await p.waitForTimeout(200);
    return await p.evaluate(() => {
      const out: Array<{ name: string; role: string | null; box: { x: number; y: number; w: number; h: number } }> = [];
      const seen = new Set<string>();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-component]"))) {
        const name = el.getAttribute("data-component");
        if (!name || seen.has(name)) continue; // first (root) occurrence per component wins
        seen.add(name);
        const r = el.getBoundingClientRect();
        out.push({
          name,
          role: el.getAttribute("data-section"),
          box: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height },
        });
      }
      return out;
    });
  } finally {
    await p.close();
  }
}

/** Measure arbitrary CSS selectors' boxes (document coords) on a settled page. */
async function measureSelectors(
  browser: Browser,
  url: string,
  width: number,
  assetsFallback: string | null,
  selectors: string[],
): Promise<Map<string, { x: number; y: number; w: number; h: number }>> {
  const result = new Map<string, { x: number; y: number; w: number; h: number }>();
  if (selectors.length === 0) return result;
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    if (assetsFallback) {
      await p.route("**/*", (route) => {
        const u = route.request().url();
        if (u.includes("/assets/")) {
          const rel = decodeURIComponent(u.split("/assets/")[1].split("?")[0]);
          const alt = path.join(assetsFallback, rel);
          if (fs.existsSync(alt)) return route.fulfill({ path: alt }).catch(() => route.abort());
        }
        return route.continue();
      });
    }
    await p.goto(url, { waitUntil: "networkidle" });
    await p.evaluate(async () => {
      const withTimeout = (pr: Promise<unknown>, ms: number) =>
        Promise.race([pr.catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
      if (document.fonts) await withTimeout(document.fonts.ready, 5000);
      for (const img of Array.from(document.querySelectorAll("img"))) {
        img.loading = "eager";
        if (!(img.complete && img.naturalWidth > 0)) await withTimeout(img.decode(), 3000);
      }
    });
    await p.waitForTimeout(200);
    const boxes = await p.evaluate((sels) => {
      const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
      for (const sel of sels) {
        let el: Element | null = null;
        try { el = document.querySelector(sel); } catch { el = null; }
        if (!el) { out[sel] = null; continue; }
        const r = el.getBoundingClientRect();
        out[sel] = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
      }
      return out;
    }, selectors);
    for (const [sel, box] of Object.entries(boxes)) if (box) result.set(sel, box);
    return result;
  } finally {
    await p.close();
  }
}

/** Crop a section's own box out of a full-page PNG, in a headless canvas. Returns a PNG buffer. */
async function cropBox(
  browser: Browser,
  fullPng: Buffer,
  box: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  const dp = await browser.newPage();
  try {
    const b64 = await dp.evaluate(async ([pngB64, bx]) => {
      const b = bx as { x: number; y: number; w: number; h: number };
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("crop: image decode failed"));
        i.src = "data:image/png;base64," + (pngB64 as string);
      });
      // Clamp the box to the image bounds (a section can extend a hair past the shot).
      const x0 = Math.max(0, Math.floor(b.x));
      const y0 = Math.max(0, Math.floor(b.y));
      const x1 = Math.min(img.width, Math.ceil(b.x + b.w));
      const y1 = Math.min(img.height, Math.ceil(b.y + b.h));
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
      return cv.toDataURL("image/png").split(",")[1];
    }, [fullPng.toString("base64"), box] as const);
    return Buffer.from(b64, "base64");
  } finally {
    await dp.close();
  }
}

/**
 * Build the shipped artifact from `site`, render it, and capture a per-section snapshot at
 * `width`. Each section is cropped by its OWN bounding box (position-independent). Assets the
 * build didn't inline are fulfilled from `assetsFallback` (the golden capture's assets/ dir).
 */
export async function renderSnapshot(
  browser: Browser,
  site: SiteRef,
  opts: { width?: number; assetsFallback?: string | null; extraSelectors?: string[] } = {},
): Promise<RenderSnapshot> {
  const width = opts.width ?? 1440;
  const assetsFallback = opts.assetsFallback ?? defaultAssetsFallback(site);
  const dist = astroBuild(site);
  const server = serveDist(dist, assetsFallback);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  try {
    const { png: fullPng, settled } = await shootSettled(browser, url, width, assetsFallback);
    const measured = await measureSections(browser, url, width, assetsFallback);
    const extraBoxes = await measureSelectors(browser, url, width, assetsFallback, opts.extraSelectors ?? []);
    const sections = new Map<string, SectionRender>();
    const order: string[] = [];
    for (const m of measured) {
      order.push(m.name);
      const cropPng = await cropBox(browser, fullPng, m.box);
      sections.set(m.name, { name: m.name, role: m.role, box: m.box, cropPng });
    }
    return { width, sections, fullPng, order, settled, extraBoxes };
  } finally {
    server.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

/** The golden capture's assets/ dir if present alongside the projected site (else null). */
function defaultAssetsFallback(site: SiteRef): string | null {
  const rootAssets = path.join(site.dir, "assets");
  if (fs.existsSync(rootAssets)) return rootAssets;
  const publicAssets = path.join(site.dir, "astro", "public", "assets");
  if (fs.existsSync(publicAssets)) return publicAssets;
  return null;
}

/** Read the projected site's section list (name + role) from site.json — the structural expectation. */
export function sectionListOf(site: SiteRef): Array<{ name: string; role: string }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(site.dir, "site.json"), "utf8")) as SiteManifest;
  const out: Array<{ name: string; role: string }> = [];
  for (const page of manifest.pages) for (const s of page.sections) out.push({ name: s.name, role: s.role });
  return out;
}
