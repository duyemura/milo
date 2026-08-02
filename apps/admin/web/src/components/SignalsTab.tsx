import { useQuery } from "@tanstack/react-query";
import { Badge } from "@pushpress/pushpress-ui";

interface Connection {
  kind: "gsc" | "ga4" | "gbp" | "places";
  externalId: string | null;
  status: string;
}

interface MetricVal {
  value: string;
  collectedAt: string;
  dimensions: Record<string, unknown>;
}

const CONNECTION_LABEL: Record<string, string> = {
  gsc: "Search Console",
  ga4: "Google Analytics",
  gbp: "Business Profile",
  places: "Google reviews (Places)",
};

function connBadge(status: string) {
  return status === "active"
    ? "bg-green-100 text-green-700"
    : status === "error"
      ? "bg-red-100 text-red-700"
      : "bg-gray-100 text-gray-600";
}

interface QueryRow {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

function safeJson<T>(v: string | undefined | null, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function fmtPercent(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${(n * 100).toFixed(0)}%`;
}

function fmtNum(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}

export function SignalsTab({ siteId }: { siteId: string }) {
  const { data } = useQuery({
    queryKey: ["site-detail", siteId],
    queryFn: async () => {
      const res = await fetch(`/api/v1/sites/${siteId}`);
      return (await res.json()) as {
        connections: Connection[];
        metricsLatest: Record<string, MetricVal>;
      };
    },
    refetchInterval: 5000,
  });

  const connections = data?.connections ?? [];
  const latest = data?.metricsLatest ?? {};
  const g = (k: string) => latest[k]?.value;

  const queries: QueryRow[] = Object.entries(latest)
    .filter(([k, m]) => k === "gsc:query" || (k.startsWith("gsc:query") && m.dimensions["query"]))
    .map(([, m]) => {
      const [clicks, impressions, position] = m.value.split("/").map(Number);
      return { query: String(m.dimensions["query"] ?? ""), clicks, impressions, position };
    })
    .filter((r) => r.impressions >= 0 && r.query)
    .sort((a, b) => b.impressions - a.impressions);

  const reviewHighlight = latest["places:recent_review"]?.value;

  const activeNow = Number(g("ga4:active_now") ?? "") || 0;
  const visitors = Number(g("ga4:visitors") ?? "") || 0;
  const pageviews = Number(g("ga4:pageviews") ?? "") || 0;
  const engagementRate = Number(g("ga4:engagement_rate") ?? "") || 0;
  const funnel = safeJson<{ visited: number; engaged: number; intent: number; converted: number }>(g("ga4:funnel"), {
    visited: pageviews,
    engaged: 0,
    intent: 0,
    converted: 0,
  });
  funnel.visited = funnel.visited || pageviews;
  const topPages = safeJson<{ path: string; views: number }[]>(g("ga4:top_pages"), []);
  const topSources = safeJson<{ source: string; users: number }[]>(g("ga4:top_sources"), []);

  const funnelMax = Math.max(funnel.visited, 1);
  const funnelSteps = [
    { label: "Visited", value: funnel.visited, color: "#3b82f6" },
    { label: "Engaged", value: funnel.engaged, color: "#84cc16" },
    { label: "Intent", value: funnel.intent, color: "#3b82f6" },
    { label: "Converted", value: funnel.converted, color: "#111827" },
  ];

  const hasGa4 = connections.some((c) => c.kind === "ga4" && c.status === "active");

  return (
    <div>
      {/* Ploy-lite engagement stats */}
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-num">{fmtNum(activeNow)}</span>
          <span className="muted">Active now</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{fmtNum(visitors)}</span>
          <span className="muted">Visitors · 28d</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{fmtPercent(engagementRate)}</span>
          <span className="muted">Engagement rate</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{fmtNum(funnel.converted)}</span>
          <span className="muted">Form submissions</span>
        </div>
      </div>

      <div className="dash-cols" style={{ marginBottom: 16 }}>
        <section className="pane">
          <h3>Conversion funnel</h3>
          {!hasGa4 && (
            <p className="muted small">GA4 not connected yet — funnel fills after a production publish.</p>
          )}
          {hasGa4 && funnel.visited === 0 && (
            <p className="muted small">No traffic yet — funnel appears once visitors roll in.</p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {funnelSteps.map((s) => (
              <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 72, fontSize: 13 }}>{s.label}</span>
                <div style={{ flex: 1, background: "#f3f4f6", borderRadius: 6, height: 18, overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${Math.min(100, (s.value / funnelMax) * 100)}%`,
                      background: s.color,
                      height: "100%",
                      borderRadius: 6,
                    }}
                  />
                </div>
                <span style={{ width: 60, textAlign: "right", fontSize: 13, fontWeight: 500 }}>
                  {fmtNum(s.value)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="pane">
          <h3>Top sources</h3>
          {topSources.length === 0 && <p className="muted small">No source data yet.</p>}
          {topSources.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {topSources.slice(0, 5).map((s, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span>{s.source}</span>
                  <span className="muted">{fmtNum(s.users)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="pane" style={{ marginBottom: 16 }}>
        <h3>Top pages</h3>
        {topPages.length === 0 && <p className="muted small">No page data yet.</p>}
        {topPages.length > 0 && (
          <table className="jobs full">
            <thead>
              <tr>
                <th>Page</th>
                <th>Views</th>
              </tr>
            </thead>
            <tbody>
              {topPages.slice(0, 10).map((p, i) => (
                <tr key={i}>
                  <td>{p.path}</td>
                  <td>{fmtNum(p.views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-num">{g("places:rating") ? `${g("places:rating")}★` : "—"}</span>
          <span className="muted">Google rating</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{g("places:review_count") ?? "—"}</span>
          <span className="muted">Google reviews</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{g("gsc:impressions_28d") ?? "—"}</span>
          <span className="muted">Search impressions · 28d</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{g("gsc:clicks_28d") ?? "—"}</span>
          <span className="muted">Search clicks · 28d</span>
        </div>
      </div>

      {reviewHighlight && (
        <div className="digest" style={{ marginBottom: 16 }}>
          <strong className="small">Latest standout review</strong>
          <p className="small">“{reviewHighlight.length > 200 ? reviewHighlight.slice(0, 200) + "…" : reviewHighlight}”</p>
        </div>
      )}

      <section className="pane" style={{ marginBottom: 16 }}>
        <h3>Connections</h3>
        {(["gsc", "ga4", "gbp", "places"] as const).map((kind) => {
          const c = connections.find((x) => x.kind === kind);
          return (
            <div key={kind} className="row" style={{ cursor: "default" }}>
              <span>
                {CONNECTION_LABEL[kind]}
                {c?.externalId && <span className="muted small"> · {c.externalId}</span>}
              </span>
              <Badge className={`${connBadge(c?.status ?? "pending")} text-xs`}>
                {c?.status ?? "not connected"}
              </Badge>
            </div>
          );
        })}
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          GSC + GA4 self-provision at the production publish (zero gym action). Business Profile insights
          wait on Google’s restricted-access approval — Places ratings run today.
        </p>
      </section>

      <section className="pane">
        <h3>Top search queries (28d)</h3>
        {queries.length === 0 && (
          <p className="muted small">
            No query data yet — impressions fill in a couple of days after the GSC property verifies
            and the site starts surfacing.
          </p>
        )}
        {queries.length > 0 && (
          <table className="jobs full">
            <thead>
              <tr>
                <th>Query</th>
                <th>Clicks</th>
                <th>Impressions</th>
                <th>Avg position</th>
              </tr>
            </thead>
            <tbody>
              {queries.map((r) => (
                <tr key={r.query}>
                  <td>{r.query}</td>
                  <td>{r.clicks}</td>
                  <td>{r.impressions}</td>
                  <td className="muted">{r.position}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
