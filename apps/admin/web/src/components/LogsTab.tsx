import { type Job } from "../api.ts";
import { LogConsole } from "./LogConsole.tsx";

export function LogsTab(props: { jobs: Job[]; live?: boolean }) {
  const latest = props.jobs.find((j) => j.type === "seed") ?? props.jobs[0];
  if (!latest) return <p className="muted">No job yet.</p>;
  return <LogConsole jobId={latest.id} live={props.live ?? false} />;
}
