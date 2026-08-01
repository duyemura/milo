import { apiCall, requireOk, type FetchLike } from "./http.ts";
import type { ServiceAccount } from "./googleAuth.ts";

export const GA_EDIT = "https://www.googleapis.com/auth/analytics.edit";
const ADMIN = "https://analyticsadmin.googleapis.com/v1alpha";

/**
 * The GA account is CREATED via API — whoever creates it owns it, so the service
 * account needs no console steps and no access grants (this killed Dan's blocker).
 */
export async function ensureAccount(opts: {
  sa: ServiceAccount;
  displayName: string;
  fetchFn?: FetchLike;
}): Promise<string> {
  const { sa, displayName, fetchFn } = opts;
  const list = await apiCall({ sa, scope: GA_EDIT, url: `${ADMIN}/accounts?pageSize=200`, fetchFn });
  const accounts =
    (list.status === 200 ? (((list.data as { accounts?: unknown[] }).accounts ?? []) as { name: string; displayName: string }[]) : []);
  const found = accounts.find((a) => a.displayName === displayName);
  if (found) return found.name;

  const created = await apiCall({
    sa,
    scope: GA_EDIT,
    url: `${ADMIN}/accounts`,
    method: "POST",
    body: { displayName, regionCode: "US" },
    fetchFn,
  });
  const acc = requireOk("ga4/accounts:create", created, [200]) as { name: string };
  return acc.name;
}

export interface Ga4Asset {
  accountName: string;
  propertyName: string;
  measurementId: string;
}

/** Ensure ga property + web data stream for a site; return its measurement ID. */
export async function ensureProperty(opts: {
  sa: ServiceAccount;
  accountName: string;
  slug: string;
  siteUrl: string;
  fetchFn?: FetchLike;
}): Promise<Ga4Asset> {
  const { sa, accountName, slug, siteUrl, fetchFn } = opts;
  const filter = encodeURIComponent(`parent:${accountName}`);
  const list = await apiCall({ sa, scope: GA_EDIT, url: `${ADMIN}/properties?filter=${filter}&pageSize=200`, fetchFn });
  let propertyName: string | null = null;
  if (list.status === 200) {
    const props = ((list.data as { properties?: unknown[] }).properties ?? []) as { name: string; displayName: string }[];
    propertyName = props.find((p) => p.displayName === slug)?.name ?? null;
  }
  if (!propertyName) {
    const created = await apiCall({
      sa,
      scope: GA_EDIT,
      url: `${ADMIN}/properties`,
      method: "POST",
      body: { parent: accountName, displayName: slug, timeZone: "America/Los_Angeles", currencyCode: "USD" },
      fetchFn,
    });
    propertyName = (requireOk("ga4/properties:create", created, [200]) as { name: string }).name;
  }

  // Data stream (existing first): measurementId lives on webStreamData.
  const streams = await apiCall({ sa, scope: GA_EDIT, url: `${ADMIN}/${propertyName}/dataStreams?pageSize=50`, fetchFn });
  const existing =
    (streams.status === 200 ? (((streams.data as { dataStreams?: unknown[] }).dataStreams ?? []) as { name: string; webStreamData?: { measurementId?: string; defaultUri?: string } }[]) : []);
  const reusable = existing.find((s) => s.webStreamData?.defaultUri === siteUrl && s.webStreamData.measurementId);
  if (reusable?.webStreamData?.measurementId) {
    return { accountName, propertyName, measurementId: reusable.webStreamData.measurementId };
  }

  const createdStream = await apiCall({
    sa,
    scope: GA_EDIT,
    url: `${ADMIN}/${propertyName}/dataStreams`,
    method: "POST",
    body: { webStreamData: { defaultUri: siteUrl } },
    fetchFn,
  });
  const stream = requireOk("ga4/dataStreams:create", createdStream, [200]) as {
    webStreamData: { measurementId: string };
  };
  return { accountName, propertyName, measurementId: stream.webStreamData.measurementId };
}

const GTAG_RE = /googletagmanager\.com\/gtag\/js\?id=[A-Z0-9-]+/;

/**
 * Idempotently inject gtag into an HTML page's <head>. Deterministic; safe to run N times.
 */
export function injectGtag(html: string, measurementId: string): { html: string; changed: boolean } {
  if (html.includes(measurementId) && GTAG_RE.test(html)) {
    return { html, changed: false };
  }
  const block = [
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>`,
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','${measurementId}');</script>`,
  ].join("\n");
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) return { html, changed: false };
  return { html: html.replace(/<head(\s[^>]*)?>/i, `${m[0]}\n${block}`), changed: true };
}

/** GSC meta tag injector (same contract). */
export function injectMeta(html: string, name: string, content: string): { html: string; changed: boolean } {
  const needle = `<meta name="${name}" content="${content}">`;
  if (html.includes(needle)) return { html, changed: false };
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) return { html, changed: false };
  return { html: html.replace(/<head(\s[^>]*)?>/i, `${m[0]}\n${needle}`), changed: true };
}
