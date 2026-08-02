import type { RunState } from "@milo/clone-engine";
import { progressLabel, progressPercent } from "../lib/progress.ts";

export function CloneProgress(props: { state: RunState; sourceUrl: string }) {
  const { state, sourceUrl } = props;
  return (
    <section className="progress">
      <h1>Cloning {sourceUrl}</h1>
      <div className="bar"><div className="bar-fill" style={{ width: `${progressPercent(state)}%` }} /></div>
      <p className="progress-label">{progressLabel(state)}</p>

      {state.discovered.length > 0 && (
        <details className="discovered" open>
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
    </section>
  );
}
