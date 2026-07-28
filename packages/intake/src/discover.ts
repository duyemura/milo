export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Follow redirects and return the canonical origin (`https://host/`). */
export async function normalizeBaseUrl(input: string, fetchLike: FetchLike): Promise<string> {
  try {
    const res = await fetchLike(input, { redirect: "follow" });
    const finalUrl = new URL(res.url || input);
    return `${finalUrl.origin}/`;
  } catch {
    return `${new URL(input).origin}/`;
  }
}

const UGC_SEGMENTS = ["/blog/", "/news/", "/wod/", "/workout/", "/articles/", "/posts/", "/insights/", "/resources/"];
const NON_HTML_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".mp4", ".mov", ".zip", ".woff", ".woff2", ".ttf", ".css", ".js", ".xml", ".ico"];

export function isUgc(url: string): boolean {
  const p = new URL(url).pathname.toLowerCase();
  const search = new URL(url).search.toLowerCase();
  if (UGC_SEGMENTS.some((seg) => p.includes(seg))) return true;
  if (/\/(19|20)\d{2}(\/\d{2})?\//.test(p)) return true;        // /2024/ or /2026/03/
  if (/[?&](p|cat)=/.test(search)) return true;                  // wordpress
  return false;
}

export function isNonHtml(url: string): boolean {
  const p = new URL(url).pathname.toLowerCase();
  return NON_HTML_EXT.some((ext) => p.endsWith(ext));
}

export function slugFor(url: string, baseUrl: string): string {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  if (path === "" || url === baseUrl) return "index";
  return path.replace(/\//g, "-").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "index";
}

const PRIORITY_RULES: Array<[RegExp, number]> = [
  [/\/(about|our-story|story|mission)/i, 2],
  [/\/(coaches|team|staff|trainers)/i, 3],
  [/\/(programs|classes|services|training)/i, 4],
  [/\/(pricing|membership|join|rates|plans)/i, 5],
  [/\/(schedule|timetable|calendar)/i, 6],
  [/\/(faq|questions)/i, 7],
  [/\/(contact|location|visit)/i, 8],
];

export function priorityFor(url: string): number {
  const path = new URL(url).pathname;
  if (path === "/" || path === "") return 1;
  for (const [re, score] of PRIORITY_RULES) if (re.test(path)) return score;
  return 9;
}
