import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button } from "@pushpress/pushpress-ui";
import { api, type Job, type Site } from "../api.ts";

function statusBadge(status: string) {
  const map: Record<string, string> = {
    registered: "bg-gray-100 text-gray-600",
    seeding: "bg-blue-100 text-blue-700",
    seeded: "bg-blue-100 text-blue-700",
    built: "bg-green-100 text-green-700",
    deployed: "bg-green-100 text-green-700",
    error: "bg-red-100 text-red-700",
  };
  return <Badge className={`${map[status] ?? "bg-gray-100 text-gray-600"} text-xs`}>{status}</Badge>;
}

function jobBadge(status: Job["status"]) {
  const map: Record<string, string> = {
    waiting: "bg-gray-100 text-gray-600",
    queued: "bg-blue-100 text-blue-700",
    running: "bg-blue-100 text-blue-700",
    succeeded: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };
  return <Badge className={`${map[status]} text-xs`}>{status}</Badge>;
}

function JobLogView({ jobId, active }: { jobId: string; active: boolean }) {
  const { data } = useQuery({
    queryKey: ["job-logs", jobId],
    queryFn: () => api.jobLogs(jobId),
    refetchInterval: active ? 2000 : false,
    select: (d) => d.logs,
  });
  return (
    <pre className="logs">
      {(data ?? []).map((l) => `${l.line}\n`).join("") || "No output yet…"}
    </pre>
  );
}

export function SiteCard({ site }: { site: Site }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["site-detail", site.id],
    queryFn: () => api.siteDetail(site.id),
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => j.status === "waiting" || j.status === "queued" || j.status === "running")
        ? 2000
        : false,
  });
  const trigger = useMutation({
    mutationFn: (type: string) => api.triggerJob(site.id, type),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site-detail", site.id] }),
  });

  const jobs = data?.jobs ?? [];
  const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued");
  const canDeploy = data?.site.status === "built" || data?.site.status === "deployed";
  const deployed = data?.site.status === "deployed";

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <strong>{site.seedType === "template" ? "Template build" : "Clone"}</strong>
          {site.sourceUrl && <span className="muted"> · {site.sourceUrl}</span>}
          {site.slug && <span className="muted"> · {site.slug}</span>}
        </div>
        {statusBadge(data?.site.status ?? site.status)}
      </div>

      {data?.previewUrl && (
        <p>
          <a href={data.previewUrl} target="_blank" rel="noreferrer">
            {data.previewUrl}
          </a>
        </p>
      )}

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
        <p className="muted">Queued — position {trigger.data.job.queuePosition} (one job runs per site at a time).</p>
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
          {jobs.slice(0, 8).map((j) => (
            <tr key={j.id}>
              <td>{j.type}</td>
              <td>{jobBadge(j.status)}</td>
              <td className="muted small">{j.startedAt?.slice(11, 19) ?? "—"}</td>
              <td className="muted small">{j.error?.slice(0, 80) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {activeJob && <JobLogView jobId={activeJob.id} active />}
      {!activeJob && jobs[0] && <JobLogView jobId={jobs[0].id} active={false} />}
    </div>
  );
}
