import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";

export function ReportTab(props: { id: string }) {
  const report = useQuery({ queryKey: ["report", props.id], queryFn: () => api.report(props.id), retry: false });
  if (report.isLoading) return <p className="muted">Loading report…</p>;
  if (report.isError) return <p className="muted">No report for this build yet.</p>;
  return <pre className="report">{JSON.stringify(report.data?.report, null, 2)}</pre>;
}
