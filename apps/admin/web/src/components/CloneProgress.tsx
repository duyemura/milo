import type { RunState } from "@milo/clone-engine";
import { type Job } from "../api.ts";
import { progressLabel, progressPercent } from "../lib/progress.ts";
import { LogConsole } from "./LogConsole.tsx";

export function CloneProgress(props: { state: RunState; sourceUrl: string; jobs: Job[] }) {
  const { state, sourceUrl, jobs } = props;
  const seed = jobs.find((j) => j.type === "seed") ?? jobs[0];
  return (
    <section className="progress">
      <h1>Cloning {sourceUrl}</h1>
      <div className="bar"><div className="bar-fill" style={{ width: `${progressPercent(state)}%` }} /></div>
      <p className="progress-label">{progressLabel(state)}</p>

      {state.discovered.length > 0 && (
        <details className="discovered">
          <summary>{state.discovered.length} pages discovered</summary>
          <ul>{state.discovered.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      )}
      {state.failures.length > 0 && (
        <div className="failures">
          <h3>Skipped pages</h3>
          <ul>{state.failures.map((f) => <li key={f.route}>{f.route} — {f.error}</li>)}</ul>
        </div>
      )}

      {seed && (
        <div className="progress-console">
          <h3>Build log</h3>
          <LogConsole jobId={seed.id} live />
        </div>
      )}
    </section>
  );
}
