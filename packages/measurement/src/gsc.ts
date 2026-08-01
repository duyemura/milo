import { apiCall, requireOk, type FetchLike } from "./http.ts";
import type { ServiceAccount } from "./googleAuth.ts";

export const SC_SCOPE = "https://www.googleapis.com/auth/webmasters";
export const SV_SCOPE = "https://www.googleapis.com/auth/siteverification";

export interface GscProperty {
  propertyUrl: string;
  /** Meta-tag verification token, when the property isn't verified yet. The caller
   *  (build job) must inject this into the site's <head> and then call verify(). */
  metaTagToken: string | null;
  verified: boolean;
}

/**
 * Ensure a Search Console property exists + is verified for a site WE serve.
 * Zero-touch: we inject our own meta tag into our own page, then verify via API.
 */
export async function ensureProperty(opts: {
  sa: ServiceAccount;
  schemeUrl: string; // e.g. "https://slug-staging.mygymseo.com/"
  fetchFn?: FetchLike;
}): Promise<GscProperty> {
  const { sa, schemeUrl, fetchFn } = opts;
  const enc = encodeURIComponent(schemeUrl);

  // 1. Ensure property registered with Search Console (PUT sites/{url}).
  //    200/204 ok; 409/already-owned fine; 404 not-needed for some accounts.
  await apiCall({
    sa,
    scope: SC_SCOPE,
    url: `https://www.googleapis.com/webmasters/v3/sites/${enc}`,
    method: "PUT",
    body: {},
    fetchFn,
  }).catch(() => {});
  await apiCall({ sa, scope: SC_SCOPE, url: `https://www.googleapis.com/webmasters/v3/sites/${enc}`, fetchFn }).catch(() => ({}));

  // 2. TRUE verification status comes from the siteVerification resources list —
  //    the webmasters sites list includes UNVERIFIED registrations, so it lies.
  let already = false;
  const verifiedList = await apiCall({
    sa,
    scope: SV_SCOPE,
    url: `https://www.googleapis.com/siteVerification/v1/webResource`,
    fetchFn,
  });
  if (verifiedList.status === 200) {
    const items = ((verifiedList.data as { items?: unknown[] }).items ?? []) as { site?: { identifier?: string } }[];
    already = items.some((i) => i.site?.identifier === schemeUrl);
  }

  // 3. Mint META_TAG verification token for the build job to inject, then verify once served.
  // URL_PREFIX covers subdomain URLs (staging subdomains + any https:// prefix case);
  // INET_DOMAIN is only correct for bare apex domains.
  const tok = await apiCall({
    sa,
    scope: SV_SCOPE,
    url: "https://www.googleapis.com/siteVerification/v1/token",
    method: "POST",
    body: { site: { type: "SITE", identifier: schemeUrl }, verificationMethod: "META" },
    fetchFn,
  });
  const rawToken =
    (requireOk("siteverification/token", tok, [200]) as { token?: string })?.token ?? null;
  // API returns the full <meta … content="x" …> tag; the injector wants the bare value.
  const token = rawToken ? (/(?:^| )content="([^"]+)"/.exec(rawToken)?.[1] ?? rawToken) : null;

  return { propertyUrl: schemeUrl, metaTagToken: token, verified: already };
}

/** Complete verification after the meta tag has been deployed to the site. */
export async function verifyNow(opts: {
  sa: ServiceAccount;
  schemeUrl: string;
  fetchFn?: FetchLike;
}): Promise<boolean> {
  const r = await apiCall({
    sa: opts.sa,
    scope: SV_SCOPE,
    url: "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=META",
    method: "POST",
    body: { site: { type: "SITE", identifier: opts.schemeUrl } },
    fetchFn: opts.fetchFn,
  });
  return r.status === 200;
}

export interface GscQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

export async function fetchQueries(opts: {
  sa: ServiceAccount;
  schemeUrl: string;
  days?: number;
  rowLimit?: number;
  fetchFn?: FetchLike;
}): Promise<GscQueryRow[]> {
  const { sa, schemeUrl } = opts;
  const end = new Date();
  const start = new Date(end.getTime() - (opts.days ?? 28) * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const r = await apiCall({
    sa,
    scope: SC_SCOPE,
    url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(schemeUrl)}/searchAnalytics/query`,
    method: "POST",
    body: { startDate: iso(start), endDate: iso(end), dimensions: ["query"], rowLimit: opts.rowLimit ?? 50 },
    fetchFn: opts.fetchFn,
  });
  const data = requireOk("searchAnalytics/query", r, [200]) as {
    rows?: { keys: string[]; clicks: number; impressions: number; position: number }[];
  };
  return (data.rows ?? []).map((row) => ({
    query: row.keys[0] ?? "",
    clicks: row.clicks,
    impressions: row.impressions,
    position: Math.round(row.position * 10) / 10,
  }));
}
