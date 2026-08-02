import { apiCall, requireOk, type FetchLike } from "./http.ts";
import type { ServiceAccount } from "./googleAuth.ts";

export const GA_READONLY = "https://www.googleapis.com/auth/analytics.readonly";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

export interface Ga4Rollup {
  propertyName: string;
  streamName: string;
  visitors: number;
  pageviews: number;
  engagementRate: number;
  activeNow: number;
  funnel: {
    visited: number;
    engaged: number;
    intent: number;
    converted: number;
  };
  topPages: { path: string; views: number }[];
  topSources: { source: string; users: number }[];
}

const FUNNEL_EVENTS = ["engaged_15s", "engaged_45s", "scroll_25", "scroll_50", "scroll_75", "scroll_90", "intent_click", "form_submit"];

function streamFilter(streamName: string): unknown {
  return {
    filter: {
      fieldName: "streamName",
      stringFilter: { matchType: "EXACT", value: streamName },
    },
  };
}

async function runReport(opts: {
  sa: ServiceAccount;
  propertyName: string;
  body: unknown;
  fetchFn?: FetchLike;
}): Promise<unknown> {
  const { sa, propertyName, body, fetchFn } = opts;
  const r = await apiCall({
    sa,
    scope: GA_READONLY,
    url: `${DATA_API}/${propertyName}:runReport`,
    method: "POST",
    body,
    fetchFn,
  });
  return requireOk("ga4data:runReport", r, [200]);
}

function parseRows(data: unknown): { dimensionValues: string[]; metricValues: string[] }[] {
  const rows = (data as { rows?: unknown[] }).rows ?? [];
  return rows.map((row) => {
    const dv = (row as { dimensionValues?: { value?: string }[] }).dimensionValues ?? [];
    const mv = (row as { metricValues?: { value?: string }[] }).metricValues ?? [];
    return {
      dimensionValues: dv.map((v) => v.value ?? ""),
      metricValues: mv.map((v) => v.value ?? ""),
    };
  });
}

function findMetricIndex(data: unknown, name: string): number {
  const h = (data as { metricHeaders?: { name?: string }[] }).metricHeaders ?? [];
  return h.findIndex((e) => e.name === name);
}

function findDimensionIndex(data: unknown, name: string): number {
  const h = (data as { dimensionHeaders?: { name?: string }[] }).dimensionHeaders ?? [];
  return h.findIndex((e) => e.name === name);
}

/**
 * Pull the last-28d Ploy-lite rollup for one site's GA4 stream. No custom dimensions
 * are required: `streamName` is the native per-site partition.
 */
export async function fetchGa4Rollup(opts: {
  sa: ServiceAccount;
  propertyName: string;
  streamName: string;
  fetchFn?: FetchLike;
}): Promise<Ga4Rollup | null> {
  const { sa, propertyName, streamName, fetchFn } = opts;
  const dateRange = { startDate: "28daysAgo", endDate: "today" };

  const realtime = await runReport({
    sa,
    propertyName,
    fetchFn,
    body: {
      dimensions: [{ name: "streamName" }],
      dimensionFilter: streamFilter(streamName),
      metrics: [{ name: "activeUsers" }],
    },
  });

  const overview = await runReport({
    sa,
    propertyName,
    fetchFn,
    body: {
      dateRanges: [dateRange],
      dimensions: [{ name: "streamName" }],
      dimensionFilter: streamFilter(streamName),
      metrics: [{ name: "totalUsers" }, { name: "screenPageViews" }, { name: "engagementRate" }, { name: "eventCount" }],
    },
  });

  const funnel = await runReport({
    sa,
    propertyName,
    fetchFn,
    body: {
      dateRanges: [dateRange],
      dimensions: [{ name: "streamName" }, { name: "eventName" }],
      dimensionFilter: {
        andGroup: {
          expressions: [streamFilter(streamName), { filter: { fieldName: "eventName", inListFilter: { values: FUNNEL_EVENTS } } }],
        },
      },
      metrics: [{ name: "eventCount" }],
    },
  });

  const pages = await runReport({
    sa,
    propertyName,
    fetchFn,
    body: {
      dateRanges: [dateRange],
      dimensions: [{ name: "streamName" }, { name: "pagePath" }],
      dimensionFilter: streamFilter(streamName),
      metrics: [{ name: "screenPageViews" }],
      limit: "10",
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    },
  });

  const sources = await runReport({
    sa,
    propertyName,
    fetchFn,
    body: {
      dateRanges: [dateRange],
      dimensions: [{ name: "streamName" }, { name: "sessionSource" }],
      dimensionFilter: streamFilter(streamName),
      metrics: [{ name: "totalUsers" }],
      limit: "10",
      orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
    },
  });

  const overviewRows = parseRows(overview);
  const realtimeRows = parseRows(realtime);
  const pageRows = parseRows(pages);
  const sourceRows = parseRows(sources);
  const funnelRows = parseRows(funnel);

  const toNum = (v: string) => (v === "" ? 0 : Number(v));
  const engagementIdx = findMetricIndex(overview, "engagementRate");
  const visitorsIdx = findMetricIndex(overview, "totalUsers");
  const pageviewsIdx = findMetricIndex(overview, "screenPageViews");
  const activeIdx = findMetricIndex(realtime, "activeUsers");

  const first = overviewRows[0];
  const visitors = first && visitorsIdx >= 0 ? toNum(first.metricValues[visitorsIdx]) : 0;
  const pageviews = first && pageviewsIdx >= 0 ? toNum(first.metricValues[pageviewsIdx]) : 0;
  const engagementRate = first && engagementIdx >= 0 ? toNum(first.metricValues[engagementIdx]) : 0;
  const activeNow = realtimeRows[0] && activeIdx >= 0 ? toNum(realtimeRows[0].metricValues[activeIdx]) : 0;

  const eventIdx = findDimensionIndex(funnel, "eventName");
  const eventCountIdx = findMetricIndex(funnel, "eventCount");
  const eventCounts: Record<string, number> = {};
  for (const row of funnelRows) {
    const name = eventIdx >= 0 ? row.dimensionValues[eventIdx] : "";
    const count = eventCountIdx >= 0 ? toNum(row.metricValues[eventCountIdx]) : 0;
    if (name) eventCounts[name] = count;
  }

  // Funnel mapping: visited=page_view is approximated by pageviews; engaged=any engaged_15s/45s; intent=intent_click; converted=form_submit.
  const engaged = (eventCounts["engaged_15s"] ?? 0) + (eventCounts["engaged_45s"] ?? 0);

  const pagePathIdx = findDimensionIndex(pages, "pagePath");
  const pageViewsIdx = findMetricIndex(pages, "screenPageViews");
  const topPages = pageRows.map((row) => ({
    path: pagePathIdx >= 0 ? row.dimensionValues[pagePathIdx] : "",
    views: pageViewsIdx >= 0 ? toNum(row.metricValues[pageViewsIdx]) : 0,
  })).filter((r) => r.path);

  const sourceDimIdx = findDimensionIndex(sources, "sessionSource");
  const sourceUsersIdx = findMetricIndex(sources, "totalUsers");
  const topSources = sourceRows.map((row) => ({
    source: sourceDimIdx >= 0 ? row.dimensionValues[sourceDimIdx] : "",
    users: sourceUsersIdx >= 0 ? toNum(row.metricValues[sourceUsersIdx]) : 0,
  })).filter((r) => r.source);

  return {
    propertyName,
    streamName,
    visitors,
    pageviews,
    engagementRate,
    activeNow,
    funnel: {
      visited: pageviews,
      engaged,
      intent: eventCounts["intent_click"] ?? 0,
      converted: eventCounts["form_submit"] ?? 0,
    },
    topPages,
    topSources,
  };
}
