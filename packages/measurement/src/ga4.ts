import { apiCall, requireOk, type FetchLike } from "./http.ts";
import type { ServiceAccount } from "./googleAuth.ts";

export const GA_EDIT = "https://www.googleapis.com/auth/analytics.edit";
const ADMIN = "https://analyticsadmin.googleapis.com/v1alpha";

/**
 * GA accounts cannot be created by API (Google requires interactive TOS once per org).
 * Strategy: take a provided account name when present (env/provisioned once manually),
 * otherwise find one matching displayName in the SA's visible accounts, else attempt
 * create (future-proof) and surface a precise error.
 */
export async function ensureAccount(opts: {
  sa: ServiceAccount;
  displayName: string;
  accountNameProvided?: string;
  fetchFn?: FetchLike;
}): Promise<string> {
  const { sa, displayName, accountNameProvided, fetchFn } = opts;
  if (accountNameProvided) return accountNameProvided;
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
  if (created.status === 404) {
    throw new Error(
      `GA accounts can't be created by API (Google requires interactive TOS once per org). Provision a GA4 account once in analytics.google.com and set GA_ACCOUNT_NAME=<accounts/ID> — everything after that is automatic.`,
    );
  }
  const acc = requireOk("ga4/accounts:create", created, [200]) as { name: string };
  return acc.name;
}

export interface Ga4Asset {
  accountName: string;
  propertyName: string;
  measurementId: string;
}

/**
 * Ensure the SHARED measurement property exists (fleet-wide roll-up), then ensure this
 * site's web data stream inside it. One property per environment; one stream per site —
 * GA4 partitions natively by stream, and every site's events still carry its own ID.
 *
 * NOTE: GA4 caps properties at ~50 data streams. At real fleet scale we shard by
 * cohort (pushpress-sites-staging-001, -002 …) — the call site stays identical.
 */
export async function ensureSharedProperty(opts: {
  sa: ServiceAccount;
  accountName: string;
  propertyDisplay: string;
  fetchFn?: FetchLike;
}): Promise<string> {
  const { sa, accountName, propertyDisplay, fetchFn } = opts;
  const filter = encodeURIComponent(`parent:${accountName}`);
  const list = await apiCall({ sa, scope: GA_EDIT, url: `${ADMIN}/properties?filter=${filter}&pageSize=200`, fetchFn });
  if (list.status === 200) {
    const props = ((list.data as { properties?: unknown[] }).properties ?? []) as { name: string; displayName: string }[];
    const found = props.find((p) => p.displayName === propertyDisplay);
    if (found) return found.name;
  }
  const created = await apiCall({
    sa,
    scope: GA_EDIT,
    url: `${ADMIN}/properties`,
    method: "POST",
    body: { parent: accountName, displayName: propertyDisplay, timeZone: "America/Los_Angeles", currencyCode: "USD" },
    fetchFn,
  });
  const acc = requireOk("ga4/properties:create", created, [200]) as { name: string };
  return acc.name;
}

export async function ensureStream(opts: {
  sa: ServiceAccount;
  propertyName: string;
  slug: string;
  siteUrl: string;
  fetchFn?: FetchLike;
}): Promise<{ measurementId: string; streamName: string }> {
  const { sa, propertyName, slug, siteUrl, fetchFn } = opts;
  const streams = await apiCall({ sa, scope: GA_EDIT, url: `${ADMIN}/${propertyName}/dataStreams?pageSize=200`, fetchFn });
  const existing =
    (streams.status === 200 ? (((streams.data as { dataStreams?: unknown[] }).dataStreams ?? []) as { name: string; webStreamData?: { measurementId?: string; defaultUri?: string } }[]) : []);
  const reusable = existing.find((s) => s.webStreamData?.defaultUri === siteUrl && s.webStreamData.measurementId);
  if (reusable?.webStreamData?.measurementId) {
    return { measurementId: reusable.webStreamData.measurementId, streamName: reusable.name };
  }

  const createdStream = await apiCall({
    sa,
    scope: GA_EDIT,
    url: `${ADMIN}/${propertyName}/dataStreams`,
    method: "POST",
    body: { webStreamData: { defaultUri: siteUrl }, description: slug },
    fetchFn,
  });
  const stream = requireOk("ga4/dataStreams:create", createdStream, [200]) as {
    name: string;
    webStreamData: { measurementId: string };
  };
  return { measurementId: stream.webStreamData.measurementId, streamName: stream.name };
}

/**
 * Back-compat single-call entry (legacy): shared-property flow with the slug as the
 * property display when no shared name is provided by the caller.
 */
export async function ensureProperty(opts: {
  sa: ServiceAccount;
  accountName: string;
  slug: string;
  siteUrl: string;
  fetchFn?: FetchLike;
}): Promise<Ga4Asset> {
  void opts.accountName;
  throw new Error("ensureProperty is retired — call ensureSharedProperty + ensureStream (one shared property per environment, one stream per site).");
}

const GTAG_RE = /googletagmanager\.com\/gtag\/js\?id=[A-Z0-9-]+/;

/**
 * Idempotently inject gtag into an HTML page's <head>. Deterministic; safe to run N times.
 * `siteId` is carried on every event as the site_id parameter (fleet partitioning).
 */
export interface GtagContext {
  /** site slug/id — the per-site partition. */
  siteId?: string;
  /** client org (may own multiple gyms/sites). */
  workspaceId?: string;
  /** the gym (PushPress company). */
  companyId?: string;
  /** staging | production — keeps staging traffic out of prod reports. */
  env?: string;
}

export function injectGtag(html: string, measurementId: string, ctx?: GtagContext): {
  html: string;
  changed: boolean;
} {
  if (html.includes(measurementId) && GTAG_RE.test(html)) {
    return { html, changed: false };
  }
  const clean = (v: string) => v.replace(/'/g, "");
  const params = ctx
    ? Object.entries({
        site_id: ctx.siteId,
        workspace_id: ctx.workspaceId,
        company_id: ctx.companyId,
        env: ctx.env,
      })
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}: '${clean(v as string)}'`)
        .join(", ")
    : "";
  const siteParam = params ? `, { ${params} }` : "";
  const block = [
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>`,
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','${measurementId}'${siteParam});</script>`,
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
