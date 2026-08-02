import { useState } from "react";
import { Button } from "@pushpress/pushpress-ui";
import type { RunState } from "@milo/clone-engine";
import { api, type Job } from "../api.ts";
import { LogsTab } from "./LogsTab.tsx";
import { ReportTab } from "./ReportTab.tsx";

type Tab = "preview" | "report" | "logs";
type Device = "desktop" | "mobile";

export function PreviewPane(props: { id: string; state: RunState; jobs: Job[]; stagingUrl: string | null }) {
  const { id, state, jobs, stagingUrl } = props;
  const [tab, setTab] = useState<Tab>("preview");
  const [device, setDevice] = useState<Device>("desktop");
  const failed = state.status === "failed";

  // Every build auto-deploys to staging — surface where it landed (or that it's on its way).
  const deployJob = jobs.find((j) => j.type === "deploy-staging");
  const deploying = deployJob != null && ["waiting", "queued", "running"].includes(deployJob.status);
  const deployFailed = deployJob?.status === "failed";

  return (
    <div className="pane-layout">
      <aside className="chat-rail">
        <h2>Chat</h2>
        <div className="chat-log muted">
          {failed ? (
            <p>This build failed. Check the logs tab.</p>
          ) : stagingUrl ? (
            <p>Live on staging: <a href={stagingUrl} target="_blank" rel="noreferrer">{stagingUrl.replace(/^https?:\/\//, "")}</a></p>
          ) : deploying ? (
            <p>Deploying to staging…</p>
          ) : deployFailed ? (
            <p className="error">Staging deploy failed. Check the logs tab.</p>
          ) : (
            <p>Your site is ready.</p>
          )}
          <p className="hint">Editing by chat is coming in the next update.</p>
        </div>
        <div className="chat-input">
          <input disabled placeholder="Editing coming soon…" />
          <Button disabled>Send</Button>
        </div>
      </aside>

      <section className="preview-area">
        <div className="tabs">
          <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>Preview</button>
          <button className={tab === "report" ? "on" : ""} onClick={() => setTab("report")}>Report</button>
          <button className={tab === "logs" ? "on" : ""} onClick={() => setTab("logs")}>Logs</button>
          {tab === "preview" && !failed && (
            <div className="device-toggle">
              <button className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")}>Desktop</button>
              <button className={device === "mobile" ? "on" : ""} onClick={() => setDevice("mobile")}>Mobile</button>
            </div>
          )}
        </div>

        {tab === "preview" && (
          failed
            ? <p className="error">No preview — the build failed. See the logs tab.</p>
            : <div className={`frame-wrap ${device}`}><iframe title="Site preview" src={api.previewUrl(id)} /></div>
        )}
        {tab === "report" && <ReportTab id={id} />}
        {tab === "logs" && <LogsTab jobs={jobs} />}
      </section>
    </div>
  );
}
