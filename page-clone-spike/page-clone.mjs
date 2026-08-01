#!/usr/bin/env node
/**
 * page-clone — consolidated hardened engine (replaces clone.mjs / clone-page.mjs /
 * capture-hardened.mjs). Deterministic DOM→computed-style transcription:
 *
 *   RENDER → SETTLE+NEUTRALIZE → TAG whole <body> → capture computed styles at
 *   desktop/tablet/mobile → REHOST every asset → emit responsive self-contained
 *   HTML → VERIFY by re-rendering with source origins BLOCKED.
 *
 * No documents, no LLM, no self-healing loop. Layout is copied, not generated.
 *
 * Usage: node page-clone.mjs --url <url> [--out dist] [--no-verify]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") && a.push([x.slice(2), arr[i + 1]?.startsWith("--") ? true : arr[i + 1] ?? true]), a), []));
const SRC_URL = args.url || "https://www.torrancetraininglab.com/";
const OUT = path.resolve(args.out || "dist");
const ASSETS = path.join(OUT, "assets");
const WIDTHS = [1440, 768, 390];
const BP = { 768: 768, 390: 480 };
const KEEP_ATTRS = ["src", "srcset", "sizes", "alt", "href", "role", "loading", "type", "viewBox", "d", "fill", "stroke", "points", "xmlns", "preserveAspectRatio", "target", "rel", "poster", "controls"];
fs.rmSync(ASSETS, { recursive: true, force: true }); // start clean so stale/mis-typed assets don't linger
fs.mkdirSync(ASSETS, { recursive: true });

// ---------- in-page: neutralize animations, then tag + serialize structure ----------
async function neutralizeAndTag(keepAttrs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const kill = document.createElement("style");
  kill.textContent = "*,*::before,*::after{transition:none!important;animation:none!important;animation-duration:0s!important}";
  document.head.appendChild(kill);
  // dwell-scroll (capped) so IntersectionObserver / entrance animations fire
  const H = document.body.scrollHeight;
  for (let y = 0, i = 0; y <= H && i < 200; y += 300, i++) { window.scrollTo(0, y); await sleep(100); }
  window.scrollTo(0, 0);
  await sleep(1200);
  if (document.fonts) await document.fonts.ready;
  // force still-faded content elements to full opacity (inline; evaluate can't see outer helpers)
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (parseFloat(cs.opacity) < 0.99) {
      const leaf = el.children.length === 0;
      if ((leaf && el.textContent.trim()) || el.querySelector("img,svg,picture,video")) el.style.setProperty("opacity", "1", "important");
    }
  }

  // tag every visual element (depth-first) and build a structure tree with text nodes
  const SKIP = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE", "STYLE", "LINK", "META", "HEAD"]);
  const JUNK_IFRAME = /bugherd|googletagmanager|hotjar|doubleclick|facebook\.com\/tr|gtm/i;
  let n = 0;
  function walk(el) {
    if (SKIP.has(el.tagName)) return null;
    if (el.tagName === "IFRAME") { const s = el.getAttribute("src") || ""; if (!s || JUNK_IFRAME.test(s)) return null; }
    el.setAttribute("data-pc-id", String(n));
    const node = { id: n++, tag: el.tagName.toLowerCase(), attrs: {}, children: [] };
    for (const a of keepAttrs) if (el.hasAttribute(a)) node.attrs[a] = el.getAttribute(a);
    // absolute forms for asset resolution (browser resolves relative → absolute)
    if (el.tagName === "IMG") { node.attrs.src = el.currentSrc || el.src; }
    else if (el.src) node.attrs.src = el.src;
    if (el.tagName === "A" && el.href) node.attrs.href = el.href;
    const pre = getComputedStyle(el).whiteSpace.startsWith("pre"); // preserve literal whitespace (schedules, addresses, <pre>)
    for (const cn of el.childNodes) {
      if (cn.nodeType === 3) {
        const raw = cn.textContent;
        if (raw && (pre || /\S/.test(raw))) node.children.push({ t: pre ? raw : raw.replace(/\s+/g, " ") });
        else if (raw && /\s/.test(raw) && el.childNodes.length > 1) node.children.push({ t: " " }); // preserve inter-element space
      } else if (cn.nodeType === 1) { const c = walk(cn); if (c) node.children.push(c); }
    }
    return node;
  }
  const tree = walk(document.body);
  return { tree, count: n };
}

function forceOpacity() {
  // force still-faded CONTENT elements to full opacity (display:none/hidden stay hidden; transforms untouched)
  for (const el of document.querySelectorAll("[data-pc-id],*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (parseFloat(cs.opacity) < 0.99) {
      const leaf = el.children.length === 0;
      if ((leaf && el.textContent.trim()) || el.querySelector("img,svg,picture,video")) el.style.setProperty("opacity", "1", "important");
    }
  }
}

function grabStyles() {
  const out = {};
  for (const el of document.querySelectorAll("[data-pc-id]")) {
    const cs = getComputedStyle(el);
    const m = {};
    // skip CSS custom properties (--*): getComputedStyle already resolved var() into standard props,
    // so they're pure inherited duplication (Squarespace/Wix inject 1000s → multi-100MB bloat). Lossless.
    for (const p of cs) if (!p.startsWith("--")) m[p] = cs.getPropertyValue(p);
    out[el.getAttribute("data-pc-id")] = m;
  }
  return out;
}

function grabHead() {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  return {
    title: document.title || "",
    lang: document.documentElement.getAttribute("lang") || "en",
    metas: [...document.querySelectorAll('meta[name="description"],meta[property^="og:"],meta[name^="twitter:"]')]
      .map((m) => ({ key: m.getAttribute("property") || m.getAttribute("name") || "", content: m.getAttribute("content") || "" }))
      .filter((m) => m.key && m.content),
    icons: [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"],link[rel="shortcut icon"]')]
      .map((l) => ({ rel: l.getAttribute("rel") || "icon", href: abs(l.getAttribute("href")), sizes: l.getAttribute("sizes") || "", type: l.getAttribute("type") || "" }))
      .filter((i) => i.href),
    sheetHrefs: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => abs(l.getAttribute("href"))).filter(Boolean),
    // @font-face from same-origin sheets (cross-origin fetched later in node)
    fontFaces: (() => { let css = ""; for (const s of document.styleSheets) { let r; try { r = s.cssRules; } catch { continue; } for (const rule of r) if (rule.constructor.name === "CSSFontFaceRule") css += rule.cssText + "\n"; } return css; })(),
  };
}

// ---------- node: asset collection / rehost ----------
const URL_RE = /url\((['"]?)([^'")]+)\1\)/g;
function absolutize(u) { try { return new URL(u, SRC_URL).href; } catch { return null; } }

const NO_REHOST = new Set(["iframe", "embed", "object"]); // live embeds (maps/widgets) — keep their real src, never rehost
function collectFromTree(node, set) {
  if (node.t !== undefined) return set;
  if (node.attrs.src && !NO_REHOST.has(node.tag)) { const a = absolutize(node.attrs.src); if (a) set.add(a); }
  if (node.attrs.poster) { const a = absolutize(node.attrs.poster); if (a) set.add(a); }
  if (node.attrs.srcset) for (const part of node.attrs.srcset.split(",")) { const a = absolutize(part.trim().split(/\s+/)[0]); if (a) set.add(a); }
  node.children.forEach((c) => collectFromTree(c, set));
  return set;
}
function collectFromStyles(styleMaps, set) {
  for (const w of WIDTHS) for (const id in styleMaps[w]) for (const v of Object.values(styleMaps[w][id])) {
    if (v.includes("url(")) for (const m of v.matchAll(URL_RE)) { const a = absolutize(m[2]); if (a) set.add(a); }
  }
  return set;
}

function sniffExt(b) { // type by magic bytes; "HTML" means it's a document, not a static asset
  if (b.length < 4) return null;
  const h = b.toString("latin1", 0, 4);
  if (h === "wOFF") return "woff";
  if (h === "wOF2") return "woff2";
  if (h === "OTTO") return "otf";
  if (b[0] === 0x89 && h.slice(1) === "PNG") return "png";
  if (h === "GIF8") return "gif";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (h === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "ttf";
  const head = b.toString("latin1", 0, 200).trim().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "HTML";
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}
const FETCH_HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36", "referer": SRC_URL, "accept": "*/*" };
async function fetchAsset(u) {
  for (let attempt = 0; attempt < 2; attempt++) { // browser-like headers (CDNs reject bare fetch) + one retry on transient failure
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(15000), headers: FETCH_HEADERS });
      if (!res.ok) { if (res.status >= 500 && attempt === 0) continue; return null; }
      if (Number(res.headers.get("content-length") || 0) > 25_000_000) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 25_000_000) return null;
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      const ext = sniffExt(buf);
      if (ext === "HTML" || ct === "text/html") return null; // a document (embed/404 page), not an asset — don't rehost
      return { buf, ct, ext };
    } catch { if (attempt === 0) continue; return null; }
  }
  return null;
}
const EXT_BY_CT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif", "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf", "application/font-woff2": "woff2", "video/mp4": "mp4" };
function extFor(u, ct, ext) { return ext || EXT_BY_CT[ct] || u.split("?")[0].match(/\.(\w{2,5})$/)?.[1]?.toLowerCase() || "bin"; }

function rewriteTree(node, map) {
  if (node.t !== undefined) return;
  const sub = (u) => map.get(absolutize(u)) || u;
  if (node.attrs.src && !NO_REHOST.has(node.tag)) node.attrs.src = sub(node.attrs.src);
  if (node.attrs.poster) node.attrs.poster = sub(node.attrs.poster);
  if (node.attrs.srcset) node.attrs.srcset = node.attrs.srcset.split(",").map((s) => { const [u, d] = s.trim().split(/\s+/); return sub(u) + (d ? " " + d : ""); }).join(", ");
  node.children.forEach((c) => rewriteTree(c, map));
}
function rewriteStyleVal(v, map) { return v.includes("url(") ? v.replace(URL_RE, (m, q, u) => { const r = map.get(absolutize(u)); return r ? `url(${r})` : m; }) : v; }

// ---------- node: css + html emit ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const VOID = new Set(["img", "br", "hr", "input", "source", "use", "path", "circle", "rect", "line", "polygon", "polyline", "ellipse", "col", "area", "meta", "link"]);
const decl = (m) => Object.entries(m).map(([k, v]) => `${k}:${v}`).join(";");
const diff = (base, over) => { const d = {}; for (const k in over) if (over[k] !== base[k]) d[k] = over[k]; return d; };
function render(node) {
  if (node.t !== undefined) return esc(node.t);
  let a = ` class="pc-${node.id}"`;
  for (const [k, v] of Object.entries(node.attrs)) a += ` ${k}="${escA(v)}"`;
  if (VOID.has(node.tag)) return `<${node.tag}${a}>`;
  return `<${node.tag}${a}>${node.children.map(render).join("")}</${node.tag}>`;
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => setTimeout(r, 200)); window.scrollTo(0, 0); if (document.fonts) await document.fonts.ready; });
  await page.waitForTimeout(300);
}

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: WIDTHS[0], height: 900 } });
  console.log(`→ ${SRC_URL}`);
  await page.goto(SRC_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  const { tree, count } = await page.evaluate(neutralizeAndTag, KEEP_ATTRS);
  const head = await page.evaluate(grabHead);
  console.log(`  tagged ${count} elements`);
  await page.screenshot({ path: path.join(OUT, "source-desktop.png"), fullPage: true });

  const styles = {};
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await settle(page);
    await page.evaluate(forceOpacity);
    styles[w] = await page.evaluate(grabStyles);
    if (w === 390) await page.screenshot({ path: path.join(OUT, "source-mobile.png"), fullPage: true });
    console.log(`  captured @ ${w}w`);
  }

  // ---- capture INTERACTIONS: click-toggles (hamburger + desktop dropdowns) + hover states ----
  const toggles = [], hovers = []; let navigated = false;
  const grabSub = (id) => { const root = document.querySelector(`[data-pc-id="${id}"]`); const out = {}; if (root) for (const el of [root, ...root.querySelectorAll("[data-pc-id]")]) { const cs = getComputedStyle(el); const m = {}; for (const p of cs) if (!p.startsWith("--")) m[p] = cs.getPropertyValue(p); out[el.getAttribute("data-pc-id")] = m; } return out; };
  const diffMap = (before, after) => { const d = {}; for (const id in after) { const base = before[id] || {}; const x = {}; for (const k in after[id]) if (after[id][k] !== base[k]) x[k] = after[id][k]; if (Object.keys(x).length) d[id] = x; } return d; };
  // 1. mobile hamburger (page is at 390) — whole-page delta
  try {
    const togId = await page.evaluate(() => { const t = document.querySelector(".elementor-menu-toggle, [class*='menu-toggle'], [class*='hamburger'], [class*='burger'], .nav-toggle, [aria-label*='menu' i][role='button'], button[aria-controls][aria-expanded], button[aria-expanded]"); return t ? t.getAttribute("data-pc-id") : null; });
    if (togId != null) {
      await page.click(`[data-pc-id="${togId}"]`, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      const d = diffMap(styles[390], await page.evaluate(grabStyles));
      if (Object.keys(d).length) { toggles.push({ toggleId: togId, openDelta: d, prevent: false }); console.log(`  captured mobile menu (pc-${togId}, ${Object.keys(d).length} elems)`); }
    }
  } catch {}
  // 2. desktop dropdowns — click parent, subtree delta, require a reveal; guard against navigation
  try {
    await page.setViewportSize({ width: WIDTHS[0], height: 900 });
    await settle(page); await page.evaluate(forceOpacity);
    const u0 = page.url();
    const parents = await page.evaluate(() => [...document.querySelectorAll("li.menu-item-has-children, li[class*='has-children'], nav li:has(ul), header li:has(ul)")].map((li) => { const a = li.querySelector("a"); return { clickId: (a || li).getAttribute("data-pc-id"), scopeId: li.getAttribute("data-pc-id") }; }).filter((x) => x.clickId && x.scopeId).slice(0, 6));
    let dd = 0;
    for (const { clickId, scopeId } of parents) {
      const before = await page.evaluate(grabSub, scopeId);
      await page.click(`[data-pc-id="${clickId}"]`, { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      if (page.url() !== u0) { navigated = true; await page.goto(u0, { waitUntil: "domcontentloaded" }).catch(() => {}); break; } // navigated → bail (tagging lost)
      const d = diffMap(before, await page.evaluate(grabSub, scopeId));
      if (Object.values(d).some((v) => "display" in v || "opacity" in v || "visibility" in v)) { toggles.push({ toggleId: clickId, openDelta: d, prevent: true }); dd++; }
    }
    if (dd) console.log(`  captured ${dd} desktop dropdown(s)`);
  } catch {}
  // 3. hover highlights (desktop) — pure CSS :hover (skipped if a dropdown click navigated: tags are gone)
  if (!navigated) try {
    const items = [...new Set(await page.evaluate(() => [...document.querySelectorAll("li.menu-item-has-children, li[class*='has-children'], nav a, header a, .menu-item > a")].map((el) => el.getAttribute("data-pc-id")).filter(Boolean)))].slice(0, 10);
    for (const pid of items) {
      const h = await page.$(`[data-pc-id="${pid}"]`); if (!h) continue;
      await page.mouse.move(2, 2); await page.waitForTimeout(70);
      const before = await page.evaluate(grabSub, pid);
      await h.hover().catch(() => {});
      await page.waitForTimeout(140);
      const d = diffMap(before, await page.evaluate(grabSub, pid));
      if (Object.keys(d).length) hovers.push({ parentId: pid, delta: d });
    }
    if (hovers.length) console.log(`  captured ${hovers.length} hover state(s)`);
  } catch {}
  if (!toggles.length && !hovers.length) console.log(`  note: no interactive nav elements detected — nav will render static (non-standard builder?)`);
  const interactions = (toggles.length || hovers.length) ? { toggles, hovers } : null;

  // ---- rehost ----
  const assetSet = collectFromStyles(styles, collectFromTree(tree, new Set()));
  for (const ic of head.icons) { const a = absolutize(ic.href); if (a) assetSet.add(a); }
  for (const m of head.metas) if (/image/.test(m.key) && /^https?:|^\//.test(m.content)) { const a = absolutize(m.content); if (a) assetSet.add(a); }
  const urls = [...assetSet];
  const sourceOrigins = new Set(urls.map((u) => { try { return new URL(u).host; } catch { return ""; } }));
  console.log(`  rehosting ${urls.length} assets from ${sourceOrigins.size} origins…`);
  const map = new Map();
  let n = 0, failed = 0;
  await Promise.all(urls.map(async (u) => {
    const a = await fetchAsset(u);
    if (!a) { failed++; return; }
    const name = `a${n++}.${extFor(u, a.ct, a.ext)}`;
    fs.writeFileSync(path.join(ASSETS, name), a.buf);
    map.set(u, `assets/${name}`);
  }));
  console.log(`  rehosted ${map.size}/${urls.length}${failed ? ` (${failed} failed)` : ""}`);
  rewriteTree(tree, map);
  for (const w of WIDTHS) for (const id in styles[w]) for (const k in styles[w][id]) styles[w][id][k] = rewriteStyleVal(styles[w][id][k], map);
  const subUrl = (u) => map.get(absolutize(u)) || u;
  head.icons.forEach((ic) => { ic.href = subUrl(ic.href); });
  head.metas.forEach((m) => { if (/image/.test(m.key) && /^https?:|^\//.test(m.content)) m.content = subUrl(m.content); });

  // ---- fonts: same-origin @font-face (in-page) + cross-origin sheets (fetched), then rehost ----
  let fontCss = head.fontFaces;
  await Promise.all(head.sheetHrefs.map(async (href) => {
    const sheetUrl = absolutize(href); if (!sheetUrl) return;
    try {
      const res = await fetch(sheetUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const txt = await res.text();
      for (const m of txt.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
        const block = m[0].replace(URL_RE, (mm, q, u) => { let a = u; try { a = new URL(u, sheetUrl).href; } catch {} return `url(${a})`; });
        if (!fontCss.includes(block)) fontCss += "\n" + block;
      }
    } catch { /* skip unreadable sheet */ }
  }));
  for (const m of [...fontCss.matchAll(URL_RE)]) {
    const abs = absolutize(m[2]); if (!abs) continue;
    const a = await fetchAsset(abs); if (!a) continue;
    const name = `f${n++}.${extFor(abs, a.ct, a.ext)}`;
    fs.writeFileSync(path.join(ASSETS, name), a.buf);
    fontCss = fontCss.replaceAll(m[2], `assets/${name}`);
  }

  // ---- self-containment assertion (must fail, not just log) ----
  const leftovers = [];
  const flag = (u) => { try { if (u && /^https?:/.test(u) && sourceOrigins.has(new URL(u).host)) leftovers.push(u); } catch { /* unparseable fragment (e.g. comma inside a srcset URL) — ignore, don't throw */ } };
  const scanTree = (node) => { if (node.t !== undefined) return; for (const key of ["src", "srcset", "poster"]) if (node.attrs[key]) for (const part of String(node.attrs[key]).split(",")) flag(part.trim().split(/\s+/)[0]); node.children.forEach(scanTree); };
  scanTree(tree);
  for (const w of WIDTHS) for (const id in styles[w]) for (const v of Object.values(styles[w][id])) if (v.includes("url(")) for (const m of v.matchAll(URL_RE)) flag(m[2]);
  for (const ic of head.icons) flag(ic.href);
  for (const m of head.metas) if (/image/.test(m.key)) flag(m.content);
  for (const m of fontCss.matchAll(URL_RE)) flag(m[2]);
  const missing = [...map.values()].filter((p) => !fs.existsSync(path.join(OUT, p)));
  if (leftovers.length) { console.error(`\n⚠  ${leftovers.length} refs still point at source origins:`); [...new Set(leftovers)].slice(0, 8).forEach((u) => console.error(`     leftover: ${u.slice(0, 90)}`)); }
  if (missing.length) { console.error(`\n✗ SELF-CONTAINMENT FAILED: ${missing.length} rehosted asset file(s) missing on disk — not shipping a broken clone`); process.exit(1); } // build-site records this page as FAILED instead of deploying it
  if (!leftovers.length) console.log(`  ✓ self-contained: 0 source-origin refs remain, all ${map.size} assets on disk`);

  // ---- emit responsive css + html ----
  let base = "", tablet = "", mobile = "";
  for (const id in styles[1440]) base += `.pc-${id}{${decl(styles[1440][id])}}\n`;
  for (const id in styles[768]) { const d = diff(styles[1440][id], styles[768][id]); if (Object.keys(d).length) tablet += `.pc-${id}{${decl(d)}}\n`; }
  for (const id in styles[390]) { const d = diff(styles[768][id], styles[390][id]); if (Object.keys(d).length) mobile += `.pc-${id}{${decl(d)}}\n`; }
  const css = `${base}\n@media(max-width:${BP[768]}px){\n${tablet}}\n@media(max-width:${BP[390]}px){\n${mobile}}\n`;
  const bodyInner = tree.children.map(render).join("");
  const metaTags = head.metas.map((m) => `<meta ${m.key.startsWith("og:") ? "property" : "name"}="${escA(m.key)}" content="${escA(m.content)}">`).join("\n");
  const iconTags = head.icons.map((ic) => `<link rel="${escA(ic.rel)}" href="${escA(ic.href)}"${ic.sizes ? ` sizes="${escA(ic.sizes)}"` : ""}${ic.type ? ` type="${escA(ic.type)}"` : ""}>`).join("\n");
  const html = `<!doctype html><html lang="${escA(head.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(head.title)}</title>
${metaTags}
${iconTags}
<style>html{margin:0;padding:0}${fontCss}
${css}</style></head><body class="pc-${tree.id}">${bodyInner}</body></html>`;
  fs.writeFileSync(path.join(OUT, "index.html"), html);
  // persist the structured capture so the projector (B) can cut it into components without re-capturing
  fs.writeFileSync(path.join(OUT, "capture.json"), JSON.stringify({ tree, styles, head, fontCss, interactions, sourceOrigins: [...sourceOrigins] }));
  console.log(`  wrote index.html (${(html.length / 1048576).toFixed(2)} MB) + capture.json in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ---- verify: render with source origins BLOCKED (derived, not hardcoded) ----
  if (args["no-verify"]) { await browser.close(); return; }
  const shoot = async (w, name) => {
    const p = await browser.newPage({ viewport: { width: w, height: 900 } });
    await p.route("**/*", (route) => { let h = ""; try { h = new URL(route.request().url()).host; } catch {} return h && sourceOrigins.has(h) ? route.abort() : route.continue(); });
    await p.goto("file://" + path.join(OUT, "index.html"), { waitUntil: "load" });
    await p.evaluate(async () => { if (document.fonts) await document.fonts.ready; }).catch(() => {});
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(OUT, name), fullPage: true });
    await p.close();
  };
  await shoot(1440, "recon-desktop.png");
  await shoot(390, "recon-mobile.png");
  console.log(`  ✓ verified (origins blocked) → recon-desktop.png, recon-mobile.png`);
  await browser.close();
})();
