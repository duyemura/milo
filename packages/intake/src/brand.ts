import { metaContent } from "./crawl.ts";

export function extractColors(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = `#${m[1].toLowerCase()}`;
    counts[hex] = (counts[hex] ?? 0) + 1;
  }
  // rgb() → hex
  for (const m of html.matchAll(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi)) {
    const hex = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    counts[hex] = (counts[hex] ?? 0) + 1;
  }
  return counts;
}

export function extractFonts(
  _html: string,
  computed?: { display: string | null; body: string | null },
): { display: string; body: string } {
  // Brand fonts are resolved via Playwright computed styles on the rendered
  // homepage. The static HTML body is intentionally ignored — external CSS,
  // @font-face, and JS-driven font loading are only visible to the browser.
  return {
    display: computed?.display ?? "Inter",
    body: computed?.body ?? "Inter",
  };
}

export function extractLogo(html: string, baseUrl: string): string | null {
  const headerMatch = html.match(/<header\b[\s\S]*?<\/header>/i)?.[0] ?? html;
  const imgs = [...headerMatch.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const logoImg = imgs.find((tag) => /logo/i.test(tag));
  const src = (logoImg ?? imgs[0])?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (src) { try { return new URL(src, baseUrl).href; } catch { /* fall through */ } }
  const og = metaContent(html, "property", "og:image");
  if (og) { try { return new URL(og, baseUrl).href; } catch { /* skip */ } }
  return null;
}

const SOCIAL_HOSTS = ["instagram.com", "facebook.com", "twitter.com", "x.com", "youtube.com", "tiktok.com", "linkedin.com"];

export function extractSocialLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1];
    if (SOCIAL_HOSTS.some((h) => href.includes(h)) && !out.includes(href)) out.push(href);
  }
  return out;
}

const SOFTWARE_SIGNALS: Array<[string, RegExp]> = [
  ["PushPress", /pushpressapp\.com|app\.pushpress\.com/i],
  ["Mindbody", /mindbodyonline\.com|booker\.com/i],
  ["Wodify", /wodify\.com/i],
  ["Pike13", /pike13\.com/i],
  ["Glofox", /glofox\.com/i],
  ["Zen Planner", /zenplanner\.com/i],
  ["Classboom", /classboom\.com/i],
];

export function fingerprintSoftware(html: string): string | null {
  for (const [name, re] of SOFTWARE_SIGNALS) if (re.test(html)) return name;
  return null;
}

export function detectAnalytics(html: string): Record<string, string> {
  const found: Record<string, string> = {};
  const ga4 = html.match(/\bG-[A-Z0-9]{6,}\b/)?.[0];
  if (ga4) found.ga4 = ga4;
  const gtm = html.match(/\bGTM-[A-Z0-9]{4,}\b/)?.[0];
  if (gtm) found.gtm = gtm;
  if (/connect\.facebook\.net|fbq\(/i.test(html)) found.facebookPixel = html.match(/fbq\('init',\s*'(\d+)'/)?.[1] ?? "detected";
  const hotjar = html.match(/hjid\s*[:=]\s*(\d+)/)?.[1];
  if (hotjar) found.hotjar = hotjar;
  return found;
}
