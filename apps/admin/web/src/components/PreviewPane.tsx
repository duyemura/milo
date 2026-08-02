import { useState } from "react";
import { Button } from "@pushpress/pushpress-ui";
import type { RunState } from "@milo/clone-engine";
import { api, type Job } from "../api.ts";
import { LogsTab } from "./LogsTab.tsx";
import { ReportTab } from "./ReportTab.tsx";

type Tab = "preview" | "report" | "logs";
type Device = "desktop" | "mobile";

export function PreviewPane(props: { id: string; state: RunState; jobs: Job[] }) {
  const { id, state, jobs } = props;
  const [tab, setTab] = useState<Tab>("preview");
  const [device, setDevice] = useState<Device>("desktop");
  const failed = state.status === "failed";

  return (
    <div className="pane-layout">
      <aside className="chat-rail">
        <h2>Chat</h2>
        <div className="chat-log muted">
          <p>{failed ? "This build failed. Check the logs tab." : "Your site is ready."}</p>
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
