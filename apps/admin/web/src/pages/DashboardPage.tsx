import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Badge } from "@pushpress/pushpress-ui";

interface StageCount {
  stage: "onboarding" | "building" | "in-review" | "live";
  count: number;
}

interface FeedJob {
  id: string;
  siteId: string;
  type: string;
  status: string;
  error: string | null;
  createdAt: string;
  companyName: string;
  siteSlug: string | null;
  seedType: string;
}

const STAGES: { key: StageCount["stage"]; label: string }[] = [
  { key: "onboarding", label: "Onboarding" },
  { key: "building", label: "Building" },
  { key: "in-review", label: "Client review" },
  { key: "live", label: "Live" },
];

export function DashboardPage() {
  const navigate = useNavigate();
  const { data: sitesData } = useQuery({
    queryKey: ["all-sites"],
    queryFn: async () => {
      const res = await fetch("/api/v1/sites");
      return (await res.json()) as { sites: { id: string; stage: string; status: string }[] };
    },
    refetchInterval: 5000,
  });
  const { data: jobsData } = useQuery({
    queryKey: ["job-feed"],
    queryFn: async () => {
      const res = await fetch("/api/v1/jobs?limit=15");
      return (await res.json()) as { jobs: FeedJob[] };
    },
    refetchInterval: 5000,
  });

  const sites = sitesData?.sites ?? [];
  const counts = STAGES.map((s) => ({
    ...s,
    count: sites.filter((x) => x.stage === s.key).length,
    ids: sites.filter((x) => x.stage === s.key).map((x) => x.id),
  }));
  const jobs = jobsData?.jobs ?? [];
  const attention = jobs.filter((j) => j.status === "failed");
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "waiting");

  return (
    <div>
      <h2 className="page-title">Pipeline</h2>
      <div className="stage-row">
        {counts.map((c) => (
          <button
            key={c.key}
            className="stage-card"
            onClick={() => c.ids[0] && navigate(`/sites/${c.ids[0]}`)}
          >
            <span className="stage-count">{c.count}</span>
            <span className="muted">{c.label}</span>
          </button>
        ))}
      </div>

      <div className="dash-cols">
        <section className="pane">
          <h3>Active builds ({running.length})</h3>
          <ul className="feed">
            {running.map((j) => (
              <li key={j.id}>
                <button className="row" onClick={() => navigate(`/sites/${j.siteId}`)}>
                  <span>
                    {j.companyName} · {j.type}
                  </span>
                  <Badge className="bg-blue-100 text-blue-700 text-xs">{j.status}</Badge>
                </button>
              </li>
            ))}
            {running.length === 0 && <p className="muted small">Nothing running right now.</p>}
          </ul>
        </section>

        <section className="pane">
          <h3>Needs attention ({attention.length})</h3>
          <ul className="feed">
            {attention.map((j) => (
              <li key={j.id}>
                <button className="row" onClick={() => navigate(`/sites/${j.siteId}`)}>
                  <span>
                    {j.companyName} · {j.type}
                    <span className="muted small"> — {j.error?.slice(0, 60)}</span>
                  </span>
                  <Badge className="bg-red-100 text-red-700 text-xs">failed</Badge>
                </button>
              </li>
            ))}
            {attention.length === 0 && <p className="muted small">No failed jobs.</p>}
          </ul>
        </section>
      </div>

      <section className="pane">
        <h3>Recent activity</h3>
        <table className="jobs">
          <tbody>
            {jobs.slice(0, 10).map((j) => (
              <tr key={j.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/sites/${j.siteId}`)}>
                <td>{j.companyName}</td>
                <td>{j.type}</td>
                <td>
                  <Badge className="bg-gray-100 text-gray-600 text-xs">{j.status}</Badge>
                </td>
                <td className="muted small">{j.createdAt.slice(5, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
