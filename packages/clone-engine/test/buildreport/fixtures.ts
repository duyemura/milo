import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Build a minimal site dir in a temp dir. Returns its path. */
export function makeSiteDir(opts: {
  distHtml?: string;
  siteJsonSections?: { name: string; role: string; copyKeys: string[] }[];
  brandFonts?: { slot: string; family: string }[];
} = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-site-"));
  const distDir = path.join(dir, "astro", "dist");
  const stylesDir = path.join(dir, "astro", "src", "styles");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(stylesDir, { recursive: true });

  const sections = opts.siteJsonSections ?? [
    { name: "HeroSection", role: "hero", copyKeys: ["HeroSection.0", "HeroSection.1"] },
  ];
  const siteJson = {
    brand: "astro/brand.json",
    pages: [{
      route: "/", component: "Index", type: "home", goal: "convert",
      sections,
      elements: [], assets: [],
      copy: sections.flatMap((s, i) =>
        s.copyKeys.map((k, j) => ({ key: k, component: s.name, index: j, text: `Copy ${i}.${j}` }))
      ),
    }],
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(siteJson, null, 2));

  const fonts = opts.brandFonts ?? [{ slot: "display", family: "TestFont" }];
  const fontMap = Object.fromEntries(fonts.map((f) => [f.slot, f.family]));
  // BrandDoc format (matches the real projected brand.json shape)
  const brandJson = {
    colors: { primary: { value: "#ff0000", hex: "#ff0000", variants: {} } },
    fonts: { display: fontMap["display"] ?? "TestFont", body: fontMap["body"] ?? "TestBodyFont" },
    space: { sm: "8px", md: "16px", lg: "32px" },
    radius: { button: "4px", card: "8px" },
  };
  fs.writeFileSync(path.join(dir, "astro", "brand.json"), JSON.stringify(brandJson));
  // Write @font-face for every brand font (display + body derived from brandJson)
  const allFamilies = [brandJson.fonts.display, brandJson.fonts.body].filter(Boolean);
  fs.writeFileSync(
    path.join(stylesDir, "global.css"),
    allFamilies.map((f) => `@font-face { font-family: '${f}'; src: url('/${f}.woff2'); }`).join("\n"),
  );

  // When distHtml is provided it replaces the entire body; default includes an <h1> for SEO tests.
  const bodyHtml = opts.distHtml ?? [
    "<h1>Default heading</h1>",
    ...sections.map((s) =>
      `<section data-component="${s.name}" data-section="${s.role}">${s.copyKeys.map((k) => `<p data-copy="${k}">Content for ${k}</p>`).join("")}</section>`
    ),
  ].join("\n");

  fs.writeFileSync(
    path.join(distDir, "index.html"),
    `<!doctype html><html lang="en"><head><title>Test Site</title><meta name="description" content="A test site"></head><body>${bodyHtml}</body></html>`,
  );
  return dir;
}

/** A 1×1 transparent PNG (for fidelity/pixel tests — avoids network). */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Build a minimal clone source capture dir. */
export function makeCaptureDir(opts: {
  title?: string;
  description?: string;
  iframeSrcs?: string[];
  sourceOrigins?: string[];
} = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-capture-"));
  const captureJson = {
    tree: {
      id: 0, tag: "body", attrs: {}, children: [
        ...(opts.iframeSrcs ?? []).map((src, i) => ({ id: i + 1, tag: "iframe", attrs: { src }, children: [] })),
      ],
    },
    styles: {},
    head: {
      title: opts.title ?? "Source Title",
      lang: "en",
      metas: [{ key: "description", content: opts.description ?? "Source description" }],
      icons: [], sheetHrefs: [], fontFaces: "",
    },
    fontCss: "",
    interactions: null,
    sourceOrigins: opts.sourceOrigins ?? [],
  };
  fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify(captureJson));
  fs.writeFileSync(path.join(dir, "source-desktop.png"), TINY_PNG);
  return dir;
}

/** Read the built index.html from a site dir. */
export function readDistHtml(siteDir: string): string {
  return fs.readFileSync(path.join(siteDir, "astro", "dist", "index.html"), "utf8");
}

/** Build a PageContext from a site dir. */
export function makeCtx(siteDir: string, overrideHtml?: string): import("../../src/buildreport/types.ts").PageContext {
  const distDir = path.join(siteDir, "astro", "dist");
  const distHtmlPath = path.join(distDir, "index.html");
  const distHtml = overrideHtml ?? fs.readFileSync(distHtmlPath, "utf8");
  return { route: "/", distHtmlPath, distHtml, distDir, siteDir };
}
