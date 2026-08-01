import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Badge } from "@pushpress/pushpress-ui";

interface FeedJob {
  id: string;
  siteId: string;
  type: string;
  status: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  companyName: string;
  siteSlug: string | null;
  seedType: string;
}

const FILTERS: { key: string; label: string; statuses?: string }[] = [
  { key: "active", label: "Active", statuses: "waiting,queued,running" },
  { key: "failed", label: "Failed", statuses: "failed" },
  { key: "succeeded", label: "Succeeded", statuses: "succeeded" },
  { key: "all", label: "All" },
];

export function BuildsPage() {
  const [filter, setFilter] = useState("active");
  const navigate = useNavigate();
  const active = FILTERS.find((f) => f.key === filter);
  const { data } = useQuery({
    queryKey: ["builds", filter],
    queryFn: async () => {
      const q = active?.statuses ? `?status=${active.statuses}&limit=100` : "?limit=100";
      const res = await fetch(`/api/v1/jobs${q}`);
      return (await res.json()) as { jobs: FeedJob[] };
    },
    refetchInterval: 3000,
  });
  const jobs = data?.jobs ?? [];

  return (
    <div>
      <h2 className="page-title">Builds</h2>
      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`chip ${filter === f.key ? "active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <table className="jobs full">
        <thead>
          <tr>
            <th>Gym</th>
            <th>Site</th>
            <th>Job</th>
            <th>Status</th>
            <th>Started</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/sites/${j.siteId}`)}>
              <td>{j.companyName}</td>
              <td className="muted">{j.siteSlug ?? "—"}</td>
              <td>{j.type}</td>
              <td>
                <Badge
                  className={`${
                    j.status === "failed"
                      ? "bg-red-100 text-red-700"
                      : j.status === "succeeded"
                        ? "bg-green-100 text-green-700"
                        : "bg-blue-100 text-blue-700"
                  } text-xs`}
                >
                  {j.status}
                </Badge>
              </td>
              <td className="muted small">{j.startedAt?.slice(5, 19).replace("T", " ") ?? "—"}</td>
              <td className="muted small">{j.error?.slice(0, 70) ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {jobs.length === 0 && <p className="muted">No jobs in this view.</p>}
    </div>
  );
}
