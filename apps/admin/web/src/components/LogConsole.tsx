import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";

// Kept in sync with LOG_EVENT_PREFIX in src/jobs/run-state.ts — events are stored in
// job_logs with this ASCII sentinel; the console renders them as a compact bullet line.
const EVENT_PREFIX = "@@MILO_EVENT@@ ";

function renderLine(line: string): string {
  if (!line.startsWith(EVENT_PREFIX)) return line;
  try {
    const e = JSON.parse(line.slice(EVENT_PREFIX.length)) as { type: string; route?: string; error?: string };
    return `• ${e.type}${e.route ? ` ${e.route}` : ""}${e.error ? ` — ${e.error}` : ""}`;
  } catch {
    return line;
  }
}

/**
 * A dark, terminal-style view of a job's log lines. While `live`, it polls every 1.5s and
 * follows the tail (auto-scrolls to bottom) so a running build reads like a streaming
 * console. When not live it fetches once and leaves scrolling to the reader.
 */
export function LogConsole(props: { jobId: string; live: boolean }) {
  const { jobId, live } = props;
  const logs = useQuery({
    queryKey: ["logs", jobId],
    queryFn: () => api.jobLogs(jobId).then((r) => r.logs),
    enabled: !!jobId,
    refetchInterval: live ? 1500 : false,
  });
  const rows = logs.data ?? [];
  const preRef = useRef<HTMLPreElement>(null);

  // Follow the tail while live. useLayoutEffect so the scroll lands before paint (no flicker).
  useLayoutEffect(() => {
    if (!live) return;
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, live]);

  if (!jobId) return <p className="muted">No job yet.</p>;
  return (
    <pre className="logs" ref={preRef}>
      {rows.length === 0 && <div className="log-line log-empty">Waiting for output…</div>}
      {rows.map((l) => (
        <div key={l.seq} className="log-line">{renderLine(l.line)}</div>
      ))}
    </pre>
  );
}
