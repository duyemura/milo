import { type Job } from "../api.ts";
import { LogConsole } from "./LogConsole.tsx";

const DEPLOY_ACTIVE = ["waiting", "queued", "running"];

export function LogsTab(props: { jobs: Job[]; live?: boolean }) {
  const seed = props.jobs.find((j) => j.type === "seed") ?? props.jobs[0];
  const deploy = props.jobs.find((j) => j.type === "deploy-staging");
  if (!seed) return <p className="muted">No job yet.</p>;
  if (!deploy) return <LogConsole jobId={seed.id} live={props.live ?? false} />;
  // Build auto-deploys to staging as a second job — show its log below the build log so a
  // deploy failure is visible here (not just an opaque status). Poll it while it's running.
  return (
    <div className="logs-stack">
      <LogConsole jobId={seed.id} live={props.live ?? false} />
      <div className="logs-sep">— staging deploy —</div>
      <LogConsole jobId={deploy.id} live={DEPLOY_ACTIVE.includes(deploy.status)} />
    </div>
  );
}
