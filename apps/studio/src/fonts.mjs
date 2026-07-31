/** Browser-context: enumerate @font-face rules and loaded fonts. Self-contained. */
export const resolveFonts = () => {
  const faces = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (rule.constructor.name !== "CSSFontFaceRule") continue;
      faces.push({
        family: rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim(),
        weight: rule.style.getPropertyValue("font-weight") || "normal",
        style: rule.style.getPropertyValue("font-style") || "normal",
        src: rule.style.getPropertyValue("src"),
      });
    }
  }
  const loaded = [...(document.fonts || [])].map((f) => ({
    family: f.family.replace(/["']/g, ""), weight: f.weight, style: f.style, status: f.status,
  }));
  return { faces, loaded };
};

/** Extract @font-face declarations from raw CSS text (used for cross-origin stylesheets). */
export function parseFontFacesFromCss(cssText) {
  const faces = [];
  // Strip CSS comments so they do not hide rules or values.
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /@font-face\s*{([^}]*)}/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const block = m[1];
    const family = (block.match(/font-family\s*:\s*["']?([^;"'\n]+)["']?/i) || [])[1]?.trim();
    const src = (block.match(/src\s*:\s*([^;\n]+)/i) || [])[1]?.trim();
    const weight = (block.match(/font-weight\s*:\s*([^;\n]+)/i) || [])[1]?.trim() || "normal";
    const style = (block.match(/font-style\s*:\s*([^;\n]+)/i) || [])[1]?.trim() || "normal";
    if (family && src) faces.push({ family, src, weight, style });
  }
  return faces;
}

import fs from "node:fs";

async function fetchText(target) {
  if (target.startsWith("file:")) {
    return fs.promises.readFile(new URL(target), "utf8");
  }
  const res = await fetch(target);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Node-side: extract absolute font file URLs from face `src` declarations. */
export function fontFileUrls(faces, baseUrl) {
  const out = [];
  for (const f of faces) {
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let m;
    while ((m = re.exec(f.src || "")) !== null) {
      try { out.push(new URL(m[1], baseUrl).href); } catch { /* skip data: and malformed */ }
    }
  }
  return [...new Set(out)];
}

/**
 * Resolve font file URLs from both in-page @font-face rules and externally
 * fetched stylesheets. Cross-origin stylesheets are not readable via
 * `sheet.cssRules`, so we fetch their text from Node and parse @font-face
 * blocks manually.
 */
export async function resolveFontFileUrlsDeep(page, baseUrl) {
  const inPage = await page.evaluate(resolveFonts);
  const sameOriginUrls = fontFileUrls(inPage.faces, baseUrl);

  const sheetHrefs = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map((l) => l.href)
      .filter(Boolean),
  );

  const extraFaces = [];
  for (const rawHref of sheetHrefs) {
    try {
      const href = new URL(rawHref, baseUrl).href;
      const text = await fetchText(href);
      extraFaces.push(...parseFontFacesFromCss(text));
    } catch {
      /* skip unreachable or unparseable stylesheet */
    }
  }

  const crossOriginUrls = fontFileUrls(extraFaces, baseUrl);
  return {
    faces: [...inPage.faces, ...extraFaces],
    loaded: inPage.loaded,
    urls: [...new Set([...sameOriginUrls, ...crossOriginUrls])],
  };
}
