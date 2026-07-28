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

function fontVar(html: string, name: string): string | null {
  const m = html.match(new RegExp(`--font-${name}\\s*:\\s*["']?([^;"'}]+)`, "i"));
  return m ? m[1].trim() : null;
}

function familyOf(html: string, selector: string): string | null {
  const block = html.match(new RegExp(`${selector}\\s*\\{[^}]*font-family\\s*:\\s*([^;}]+)`, "i"));
  if (!block) return null;
  const first = block[1].split(",")[0].trim().replace(/["']/g, "");
  return first.startsWith("var(") ? null : first;
}

export function extractFonts(html: string): { display: string; body: string } {
  const display = fontVar(html, "heading") ?? fontVar(html, "display") ?? familyOf(html, "h1") ?? "Inter";
  const body = fontVar(html, "body") ?? familyOf(html, "body") ?? "Inter";
  return { display, body };
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
