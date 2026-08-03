/** SEO metadata for a page. */
export interface PageMeta {
  title: string;          // ≤60 chars
  description: string;    // ≤155 chars
  canonical: string;      // route e.g. "/about/"
}

/**
 * Derive SEO meta from a route + brief + site name.
 * Pure, no LLM — uses the brief as description source and route slug as title fallback.
 * For LLM-quality meta, use the llmPageMeta function (requires a chat function).
 */
export function generatePageMeta(route: string, brief: string, siteName: string): PageMeta {
  // Convert route slug to a human-readable title segment: "/about/" → "About"
  const slug = route.replace(/^\/|\/$/g, "").replace(/-/g, " ");
  const titleSegment = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : siteName;

  const title = brief
    ? `${titleSegment} | ${siteName}`.slice(0, 60)
    : `${titleSegment} | ${siteName}`.slice(0, 60);

  const description = brief
    ? brief.slice(0, 155)
    : `${titleSegment} at ${siteName}.`.slice(0, 155);

  return { title, description, canonical: route };
}

/**
 * Inject SEO meta tags into a page's HTML, replacing placeholder title and adding
 * meta description + canonical. Idempotent — won't duplicate on a second call.
 */
export function injectPageMeta(html: string, meta: PageMeta): string {
  // Replace title
  let out = html.replace(/<title>[^<]*<\/title>/i, `<title>${meta.title}</title>`);

  // Inject meta description (skip if already present)
  if (!out.includes('name="description"') && !out.includes("name='description'")) {
    out = out.replace(/<\/head>/i, `<meta name="description" content="${meta.description.replace(/"/g, "&quot;")}">\n</head>`);
  }

  // Inject canonical (skip if already present)
  if (!out.includes('rel="canonical"') && !out.includes("rel='canonical'")) {
    out = out.replace(/<\/head>/i, `<link rel="canonical" href="${meta.canonical}">\n</head>`);
  }

  return out;
}
