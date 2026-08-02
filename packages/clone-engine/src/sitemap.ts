import fs from "node:fs";
import path from "node:path";

function base(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * Generate a sitemap.xml string for the given routes.
 * If `outDir` is provided, also writes sitemap.xml to that directory.
 */
export function generateSitemap(origin: string, routes: string[], outDir?: string): string {
  const b = base(origin);
  const urls = routes.map((r) => `  <url><loc>${b}${r}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  if (outDir) fs.writeFileSync(path.join(outDir, "sitemap.xml"), xml);
  return xml;
}

/**
 * Generate a robots.txt that allows all crawlers and references the sitemap.
 * If `outDir` is provided, also writes robots.txt to that directory.
 */
export function generateRobotsTxt(origin: string, outDir?: string): string {
  const txt = `User-agent: *\nAllow: /\nSitemap: ${base(origin)}/sitemap.xml\n`;
  if (outDir) fs.writeFileSync(path.join(outDir, "robots.txt"), txt);
  return txt;
}

/** Write sitemap.xml + robots.txt into an assembled full-site directory. */
export function injectSeoFiles(fullSiteDir: string, origin: string, routes: string[]): void {
  generateSitemap(origin, routes, fullSiteDir);
  generateRobotsTxt(origin, fullSiteDir);
}
