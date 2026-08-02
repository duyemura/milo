import { useQuery } from "@tanstack/react-query";
import { api, type Job } from "../api.ts";

const EVENT_PREFIX = "@@MILO_EVENT@@ ";

export function LogsTab(props: { jobs: Job[] }) {
  const latest = props.jobs.find((j) => j.type === "seed") ?? props.jobs[0];
  const latestId = latest?.id;
  const logs = useQuery({
    queryKey: ["logs", latestId],
    queryFn: () => api.jobLogs(latestId!).then((r) => r.logs),
    enabled: !!latestId,
    refetchInterval: 2000,
  });
  if (!latest) return <p className="muted">No job yet.</p>;
  return (
    <pre className="logs">
      {(logs.data ?? []).map((l) => {
        const line = l.line.startsWith(EVENT_PREFIX) ? renderEvent(l.line.slice(EVENT_PREFIX.length)) : l.line;
        return <div key={l.seq} className="log-line">{line}</div>;
      })}
    </pre>
  );
}

function renderEvent(json: string): string {
  try {
    const e = JSON.parse(json) as { type: string; route?: string; error?: string };
    return `• ${e.type}${e.route ? ` ${e.route}` : ""}${e.error ? ` — ${e.error}` : ""}`;
  } catch {
    return json;
  }
}
