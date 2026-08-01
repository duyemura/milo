import { apiCall, requireOk, type FetchLike } from "./http.ts";
import type { ServiceAccount } from "./googleAuth.ts";

export const SC_SCOPE = "https://www.googleapis.com/auth/webmasters";

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
  const site = await apiCall({ sa, scope: SC_SCOPE, url: `https://www.googleapis.com/webmasters/v3/sites/${enc}`, fetchFn });
  const already = site.status === 200;

  // 2. Verification status — if already verified, done.
  try {
    await apiCall({
      sa,
      scope: SC_SCOPE,
      url: `https://siteverification.googleapis.com/v1/webResource?verificationMethod=META_TAG`,
      fetchFn,
    });
  } catch {
    /* best-effort pre-check */
  }

  // 3. Mint META_TAG verification token for the build job to inject, then verify once served.
  const tok = await apiCall({
    sa,
    scope: SC_SCOPE,
    url: "https://www.googleapis.com/siteverification/v1/token",
    method: "POST",
    body: { site: { type: "INET_DOMAIN", identifier: schemeUrl }, verificationMethod: "META_TAG" },
    fetchFn,
  });
  const token =
    (requireOk("siteverification/token", tok, [200]) as { token?: string })?.token ?? null;

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
    scope: SC_SCOPE,
    url: "https://www.googleapis.com/siteverification/v1/webResource?verificationMethod=META_TAG",
    method: "POST",
    body: { site: { type: "INET_DOMAIN", identifier: opts.schemeUrl } },
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
