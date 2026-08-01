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
  const metrics = Object.entries(data?.metricsLatest ?? {});

  return (
    <div>
      <section className="pane" style={{ marginBottom: 12 }}>
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
          GSC + GA4 self-provision during a measure run (zero gym action). Business Profile insights
          wait on Google's restricted-access approval — Places ratings run today.
        </p>
      </section>

      <section className="pane">
        <h3>Latest signals</h3>
        {metrics.length === 0 && (
          <p className="muted small">Nothing measured yet — run “Measure” on the Overview tab.</p>
        )}
        {metrics.length > 0 && (
          <table className="jobs">
            <tbody>
              {metrics.map(([key, m]) => (
                <tr key={key}>
                  <td className="muted">{key.replace(":", " · ")}</td>
                  <td>{m.value.length > 90 ? m.value.slice(0, 90) + "…" : m.value}</td>
                  <td className="muted small">{m.collectedAt.slice(5, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
