#!/usr/bin/env node
/**
 * Template Studio capture — point at any URL, get a capture bundle a Studio
 * session builds a template from.
 *
 * Usage: node src/capture.mjs --url <reference-url> [--out <dir>]
 *
 * Bundle contents (out dir, default captures/<host>/):
 *   meta.json        url, page height, capture settings
 *   styles.json      computed styles: typography, buttons, sections, css vars,
 *                    fonts, images, nav links (DOM = source of truth for values)
 *   sections.json    top-level visual section inventory (selector, bbox, bg, heading)
 *   m-sections.json  same segmentation on the mobile viewport
 *   full-1440.png    desktop full page
 *   vp-NN.png        desktop viewport slices
 *   m-full.png       mobile (375) full page
 *   m-vp-NN.png      mobile viewport slices
 *   dropdown.png     nav with first dropdown hover-opened (best effort)
 *   m-menu.png       mobile menu opened (best effort)
 *
 * Triangulation rule: DOM/computed styles for structured values, screenshots
 * for visual appearance. Screenshots are never the source of truth for CSS.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { segmentPage } from "./segment.mjs";
import { resolveFontFileUrlsDeep } from "./fonts.mjs";
import { collectAssetUrls, rewriteRefs, downloadAssets } from "./assets.mjs";

process.on("unhandledRejection", (err) => {
  console.error("[capture] unhandled rejection:", err);
  process.exit(1);
});

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const url = get("--url");
if (!url) {
  console.error("Usage: capture.mjs --url <reference-url> [--out <dir>]");
  process.exit(1);
}
const host = new URL(url).host.replace(/[^a-z0-9.-]/gi, "_");
const OUT = path.resolve(get("--out") ?? path.join(process.cwd(), "captures", host));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

try {
  async function settle(page) {
    await page.waitForTimeout(2500);
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 130));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);
  }

  // ---------- Desktop pass ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await settle(page);

  await page.screenshot({ path: `${OUT}/full-1440.png`, fullPage: true });

  const styles = await page.evaluate(() => {
    const pick = (el, props) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out = { text: (el.textContent || "").trim().slice(0, 80), tag: el.tagName, cls: el.className?.toString().slice(0, 120) };
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    };
    const typo = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-transform", "color"];
    const box = ["background-color", "border-radius", "padding", "margin", "box-shadow"];
    return {
      body: pick(document.body, [...typo, "background-color"]),
      h1: pick(document.querySelector("h1"), typo),
      h2s: [...document.querySelectorAll("h2")].slice(0, 8).map((e) => pick(e, typo)),
      h3s: [...document.querySelectorAll("h3")].slice(0, 8).map((e) => pick(e, typo)),
      paragraphs: [...document.querySelectorAll("p")].slice(0, 6).map((e) => pick(e, typo)),
      buttons: [...document.querySelectorAll('a[class*="button"], a[class*="btn"], .w-button, button, [role="button"]')]
        .slice(0, 10)
        .map((e) => pick(e, [...typo, ...box])),
      cssVars: (() => {
        const vars = {};
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.selectorText === ":root" || rule.selectorText === "html" || rule.selectorText === "body") {
                for (const name of rule.style) if (name.startsWith("--")) vars[name] = rule.style.getPropertyValue(name).trim();
              }
            }
          } catch {}
        }
        return vars;
      })(),
      fonts: [...document.querySelectorAll('link[rel="stylesheet"], link[href*="fonts"]')].map((l) => l.href).slice(0, 12),
      images: [...document.querySelectorAll("img")]
        .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt }))
        .filter((i) => i.w > 80)
        .slice(0, 50),
      navLinks: [...document.querySelectorAll("nav a, header a, [class*='nav'] a")]
        .slice(0, 30)
        .map((a) => ({ text: a.textContent.trim().slice(0, 60), href: a.getAttribute("href"), visible: getComputedStyle(a).display !== "none" })),
    };
  });
  fs.writeFileSync(`${OUT}/styles.json`, JSON.stringify(styles, null, 2));

  const sections = await page.evaluate(segmentPage);
  fs.writeFileSync(`${OUT}/sections.json`, JSON.stringify(sections, null, 2));

  const fontInfo = await resolveFontFileUrlsDeep(page, url);

  const totalH = await page.evaluate(() => document.body.scrollHeight);
  let idx = 0;
  for (let y = 0; y < totalH; y += 850) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/vp-${String(idx).padStart(2, "0")}.png` });
    if (++idx > 16) break;
  }

  // dropdown best effort
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const dd = await page.$(".w-dropdown-toggle, nav [aria-haspopup], header [class*='dropdown']");
  if (dd) {
    await dd.hover().catch(() => {});
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/dropdown.png` });
  }
  await page.close();

  // ---------- Mobile pass ----------
  const m = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await m.goto(url, { waitUntil: "load", timeout: 120000 });
  await settle(m);
  await m.screenshot({ path: `${OUT}/m-full.png`, fullPage: true });

  const mSections = await m.evaluate(segmentPage);
  fs.writeFileSync(`${OUT}/m-sections.json`, JSON.stringify(mSections, null, 2));

  const mH = await m.evaluate(() => document.body.scrollHeight);
  idx = 0;
  for (let y = 0; y < mH; y += 700) {
    await m.evaluate((yy) => window.scrollTo(0, yy), y);
    await m.waitForTimeout(300);
    await m.screenshot({ path: `${OUT}/m-vp-${String(idx).padStart(2, "0")}.png` });
    if (++idx > 16) break;
  }
  await m.evaluate(() => window.scrollTo(0, 0));
  const burger = await m.$(".w-nav-button, [class*='menu-button'], [class*='hamburger'], [aria-label*='menu' i]");
  if (burger) {
    await burger.click().catch(() => {});
    await m.waitForTimeout(800);
    await m.screenshot({ path: `${OUT}/m-menu.png` });
  }
  await m.close();

  const preBundle = { images: styles.images, fontUrls: fontInfo.urls, faces: fontInfo.faces, loaded: fontInfo.loaded };
  const { map: assetMap, failures: assetFailures, stats: assetStats } = await downloadAssets(collectAssetUrls(preBundle), `${OUT}/assets`);
  const bundle = rewriteRefs(preBundle, assetMap);
  fs.writeFileSync(`${OUT}/assets.json`, JSON.stringify({ ...bundle, assetMap, assetFailures, assetStats }, null, 2));

  fs.writeFileSync(
    `${OUT}/meta.json`,
    JSON.stringify({ url, desktopHeight: totalH, mobileHeight: mH, sections: sections.length, mobileSections: mSections.length, viewport: [1440, 375] }, null, 2),
  );
  console.log(JSON.stringify({ out: OUT, desktopHeight: totalH, sections: sections.length, mobileSections: mSections.length, files: fs.readdirSync(OUT).length }));
} finally {
  await browser.close();
}
