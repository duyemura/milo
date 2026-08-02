import type { GenerateRole } from "../edit/templates.ts";

export type ContentKind = "blog" | "local-seo" | "recipe" | "event" | "challenge";

export const BLUEPRINTS: Record<ContentKind, GenerateRole[]> = {
  blog:        ["hero", "content-block", "content-block", "media-block", "cta-band"],
  "local-seo": ["hero", "content-block", "feature-grid", "faq", "cta-band"],
  recipe:      ["hero", "content-block", "media-block", "cta-band"],
  event:       ["hero", "content-block", "stats-band", "lead-form"],
  challenge:   ["hero", "content-block", "stats-band", "lead-form"],
};

/** Sanitize a route to a flat slug — byte-identical to addPage's sanitizer (ops.ts:1097-1101). */
export function slugify(route: string): string {
  const slug = route
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`slugify: invalid route "${route}"`);
  return slug;
}

/** The canonical stored route for a raw input: "/<slug>/" (matches addPage). */
export function routeOf(route: string): string {
  return `/${slugify(route)}/`;
}

/** Title-Cased label from a route (nav text / SEO fallback). */
export function titleFromRoute(route: string): string {
  const slug = route.replace(/^\/+|\/+$/g, "");
  return slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
