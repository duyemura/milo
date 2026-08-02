import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type SiteDetail } from "../api.ts";
import { useRunState } from "../lib/useRunState.ts";
import { CloneProgress } from "../components/CloneProgress.tsx";
import { PreviewPane } from "../components/PreviewPane.tsx";

export function WorkbenchPage() {
  const { id = "" } = useParams();
  const detail = useQuery({ queryKey: ["site", id], queryFn: () => api.siteDetail(id), enabled: !!id });

  if (detail.isLoading || !detail.data) return <main className="workbench"><p className="muted">Loading…</p></main>;
  return <WorkbenchInner id={id} detail={detail.data} />;
}

function WorkbenchInner(props: { id: string; detail: SiteDetail }) {
  const { id, detail } = props;
  const state = useRunState(id, detail.runState);

  const done = state.status === "built" || state.status === "failed";
  return (
    <main className="workbench">
      {!done ? (
        <CloneProgress state={state} sourceUrl={detail.site.sourceUrl ?? ""} />
      ) : (
        <PreviewPane id={id} state={state} jobs={detail.jobs} />
      )}
    </main>
  );
}
