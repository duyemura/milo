import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useLocation, useParams } from "react-router-dom";
import { Badge, Button } from "@pushpress/pushpress-ui";
import { api, type Job } from "../api.ts";

const STAGE_LABELS: Record<string, string> = {
  onboarding: "Onboarding",
  building: "Building",
  "in-review": "Client review",
  live: "Live",
};

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "error"
      ? "bg-red-100 text-red-700"
      : status === "deployed" || status === "built"
        ? "bg-green-100 text-green-700"
        : "bg-blue-100 text-blue-700";
  return <Badge className={`${tone} text-xs`}>{status}</Badge>;
}

function jobBadgeClass(j: Job["status"]): string {
  return j.status === "failed"
    ? "bg-red-100 text-red-700"
    : j.status === "succeeded"
      ? "bg-green-100 text-green-700"
      : "bg-blue-100 text-blue-700";
}

function OverviewTab({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["site-detail", siteId],
    queryFn: () => api.siteDetail(siteId),
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => j.status === "waiting" || j.status === "queued" || j.status === "running")
        ? 2000
        : false,
  });
  const trigger = useMutation({
    mutationFn: (type: string) => api.triggerJob(siteId, type),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site-detail", siteId] }),
  });
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const { data: logs } = useQuery({
    queryKey: ["job-logs", expandedJob],
    queryFn: () => api.jobLogs(expandedJob as string),
    enabled: !!expandedJob,
    refetchInterval: 2000,
  });

  const jobs = data?.jobs ?? [];
  const canDeploy = data?.site.status === "built" || data?.site.status === "deployed";
  const deployed = data?.site.status === "deployed";

  return (
    <div className="card">
      <div className="actions">
        <Button disabled={trigger.isPending} onClick={() => trigger.mutate("build")}>
          Rebuild
        </Button>
        <Button disabled={trigger.isPending || !canDeploy} onClick={() => trigger.mutate("deploy-staging")}>
          Publish staging
        </Button>
        <Button disabled={trigger.isPending || !deployed} onClick={() => trigger.mutate("promote")}>
          Promote to production
        </Button>
        <Button disabled={trigger.isPending || !deployed} onClick={() => trigger.mutate("rollback")}>
          Rollback production
        </Button>
      </div>
      {trigger.error && <p className="error">{trigger.error.message}</p>}
      {trigger.data && trigger.data.job.queuePosition > 0 && (
        <p className="muted">Queued — position {trigger.data.job.queuePosition}.</p>
      )}

      <table className="jobs">
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Started</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.slice(0, 10).map((j) => (
            <tr
              key={j.id}
              style={{ cursor: "pointer" }}
              onClick={() => setExpandedJob(expandedJob === j.id ? null : j.id)}
            >
              <td>{j.type}</td>
              <td>
                <Badge className={`${jobBadgeClass(j.status)} text-xs`}>{j.status}</Badge>
              </td>
              <td className="muted small">{j.startedAt?.slice(11, 19) ?? "—"}</td>
              <td className="muted small">{j.error?.slice(0, 70) ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {expandedJob && (
        <pre className="logs">
          {(logs?.logs ?? []).map((l) => `${l.line}\n`).join("") || "No output yet…"}
        </pre>
      )}
    </div>
  );
}

function PreviewTab({ siteId }: { siteId: string }) {
  const { data } = useQuery({ queryKey: ["site-detail", siteId], queryFn: () => api.siteDetail(siteId) });
  if (!data?.previewUrl) {
    return (
      <div className="preview-empty">
        <p className="muted">No staging URL yet — publish staging to preview this site here.</p>
      </div>
    );
  }
  // Shell for the eventual AI editor: this area becomes the live site beside a chat rail.
  return <iframe className="preview-frame" src={data.previewUrl} title="Site preview" />;
}

function VersionsTab({ siteId }: { siteId: string }) {
  const { data } = useQuery({
    queryKey: ["site-detail", siteId],
    queryFn: () => api.siteDetail(siteId),
    refetchInterval: 3000,
  });
  const deploys = data?.deploys ?? [];
  return (
    <div className="card">
      <h3>Versions</h3>
      <table className="jobs">
        <thead>
          <tr>
            <th>Environment</th>
            <th>URL</th>
            <th>Status</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {deploys.map((d) => (
            <tr key={d.id}>
              <td>
                <Badge className={`${d.env === "production" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"} text-xs`}>
                  {d.env}
                </Badge>
              </td>
              <td>
                {d.url ? (
                  <a href={d.url} target="_blank" rel="noreferrer">
                    {d.url}
                  </a>
                ) : (
                  "—"
                )}
              </td>
              <td className="muted small">{d.status}</td>
              <td className="muted small">{d.createdAt.slice(5, 19).replace("T", " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {deploys.length === 0 && <p className="muted small">No deploys yet.</p>}
    </div>
  );
}

export function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const siteId = id as string;
  const { data, error, isLoading } = useQuery({
    queryKey: ["site-detail", siteId],
    queryFn: () => api.siteDetail(siteId),
  });
  const setStage = useMutation({
    mutationFn: async (stage: string) => {
      const res = await fetch(`/api/v1/sites/${siteId}/stage`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      return res.json();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site-detail", siteId] }),
  });

  if (isLoading) return <p className="muted">Loading…</p>;
  if (error || !data) return <p className="error">{error?.message ?? "Site not found."}</p>;
  const { site } = data;

  return (
    <div className="site-detail">
      <div className="site-head">
        <div>
          <h2 className="page-title">{site.slug ?? site.sourceUrl ?? "Untitled site"}</h2>
          <span className="muted small">
            {site.seedType} seed · created {site.createdAt.slice(0, 10)}
          </span>
        </div>
        <div className="site-head-right">
          <StatusBadge status={site.status} />
          <select
            className="stage-select"
            value={site.stage}
            onChange={(e) => setStage.mutate(e.target.value)}
          >
            {Object.entries(STAGE_LABELS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          {data.previewUrl && (
            <a href={data.previewUrl} target="_blank" rel="noreferrer">
              {data.previewUrl.replace(/^https:\/\//, "")}
            </a>
          )}
        </div>
      </div>

      <nav className="tabs">
        <NavLink to={`/sites/${siteId}`} end>
          Overview
        </NavLink>
        <NavLink to={`/sites/${siteId}/preview`}>Preview</NavLink>
        <NavLink to={`/sites/${siteId}/versions`}>Versions</NavLink>
      </nav>

      {pathname.endsWith("/preview") ? (
        <PreviewTab siteId={siteId} />
      ) : pathname.endsWith("/versions") ? (
        <VersionsTab siteId={siteId} />
      ) : (
        <OverviewTab siteId={siteId} />
      )}
    </div>
  );
}
