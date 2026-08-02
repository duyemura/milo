import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type SiteDetail } from "../api.ts";
import { useRunState } from "../lib/useRunState.ts";
import { CloneProgress } from "../components/CloneProgress.tsx";
import { PreviewPane } from "../components/PreviewPane.tsx";

export function WorkbenchPage() {
  const { id = "" } = useParams();
  // Poll while a build/deploy is in flight so the staging URL (set once the auto-deploy
  // finishes) and deploy status appear without a manual refresh. Stop once it's live on
  // staging (previewUrl), the deploy failed, or the build errored.
  const detail = useQuery({
    queryKey: ["site", id],
    queryFn: () => api.siteDetail(id),
    enabled: !!id,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 2000;
      if (d.previewUrl) return false;
      if (d.site.status === "error") return false;
      if (d.jobs.find((j) => j.type === "deploy-staging")?.status === "failed") return false;
      return 2500;
    },
  });

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
        <CloneProgress state={state} sourceUrl={detail.site.sourceUrl ?? ""} jobs={detail.jobs} />
      ) : (
        <PreviewPane id={id} state={state} jobs={detail.jobs} stagingUrl={detail.previewUrl} />
      )}
    </main>
  );
}
