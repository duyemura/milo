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
