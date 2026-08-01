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

  return (
    <div>
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
