/**
 * crawl.ts — BFS link crawler for same-origin pages.
 *
 * Fetches HTML from a given origin, extracts <a href> links that are same-origin,
 * and BFS-expands up to `maxPages` pages. Returns unique sorted routes.
 *
 * Skips: anchors (#…), mailto:, tel:, query-string-only (?…), external origins.
 * Normalizes: always adds trailing slash.
 */

/** Maximum pages to crawl per run (hard cap to avoid runaway). */
const DEFAULT_MAX_PAGES = 50;

function normalizeRoute(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }

  // Must be same origin.
  if (url.origin !== new URL(origin).origin) return null;

  // Skip non-http(s) schemes (mailto, tel, javascript, etc.).
  if (!url.protocol.startsWith("http")) return null;

  // Skip anchors (href="#foo" → pathname stays, but we only care about the path).
  // We do keep the pathname; the fragment is ignored.

  // Skip if the path has a file extension that is clearly not HTML.
  const ext = url.pathname.split(".").pop()?.toLowerCase() ?? "";
  const skipExts = new Set(["pdf", "jpg", "jpeg", "png", "gif", "svg", "webp", "mp4", "mp3", "zip", "xml", "json", "css", "js", "woff", "woff2", "ttf", "ico"]);
  if (skipExts.has(ext)) return null;

  // Normalize: always add trailing slash to plain paths.
  let { pathname } = url;
  if (!pathname.endsWith("/") && !pathname.includes(".")) {
    pathname = pathname + "/";
  }

  // Drop query strings — we only clone clean paths.
  return pathname;
}

function extractLinks(html: string, origin: string): string[] {
  const routes: string[] = [];
  // Match all href="..." or href='...' attributes in <a> tags.
  const re = /<a\s[^>]*href=["']([^"'#][^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const route = normalizeRoute(m[1], origin);
    if (route) routes.push(route);
  }
  return routes;
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

/**
 * Crawl a site BFS from its homepage, returning unique sorted routes (e.g. ["/", "/about/", "/blog/"]).
 *
 * @param origin  Base URL of the site (e.g. "https://speakeasyofstrength.com")
 * @param maxPages  Hard cap on pages to return (default 50)
 */
export async function crawlSite(origin: string, maxPages = DEFAULT_MAX_PAGES): Promise<string[]> {
  const base = origin.replace(/\/$/, "");
  const seen = new Set<string>();
  const queue: string[] = ["/"];
  const found: string[] = [];

  seen.add("/");

  while (queue.length > 0 && found.length < maxPages) {
    const route = queue.shift()!;
    found.push(route);

    let html: string;
    try {
      html = await fetchHtml(base + route);
    } catch (err) {
      console.warn(`[crawl] failed to fetch ${route}: ${(err as Error).message}`);
      continue;
    }

    const links = extractLinks(html, base);
    for (const link of links) {
      if (!seen.has(link)) {
        seen.add(link);
        queue.push(link);
      }
    }
  }

  return [...found].sort();
}
