import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@pushpress/pushpress-ui";

export interface Brief {
  id: string;
  keywordCluster: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  intent: "transactional" | "informational";
  suggestedUrl: string;
  pageType: string;
  goal: string;
  outline: { role: string; notes: string }[];
  localSignals: string[];
  status: "pending" | "accepted" | "built" | "dismissed";
  createdAt: string;
}

function intentBadge(intent: string) {
  return intent === "transactional"
    ? "bg-green-100 text-green-700"
    : "bg-blue-100 text-blue-700";
}

function BriefCard({ brief }: { brief: Brief }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const setStatus = useMutation({
    mutationFn: async (status: string) =>
      fetch(`/api/v1/briefs/${brief.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["briefs"] });
      void qc.invalidateQueries({ queryKey: ["todos"] });
    },
  });

  return (
    <div className="todo-card brief-card">
      <div className="brief-head" onClick={() => setOpen(!open)} style={{ cursor: "pointer" }}>
        <div>
          <strong>{brief.primaryKeyword}</strong>
          <span className="muted small"> · {brief.suggestedUrl}</span>
        </div>
        <span className="site-row-right">
          <Badge className={`${intentBadge(brief.intent)} text-xs`}>{brief.intent.replace("actional", "act.")}</Badge>
          <Badge className="bg-gray-100 text-gray-600 text-xs">{brief.status}</Badge>
        </span>
      </div>
      <span className="muted small">{brief.goal}</span>
      {brief.secondaryKeywords.length > 0 && (
        <div className="kw-chips">
          {brief.secondaryKeywords.slice(0, 5).map((k) => (
            <span key={k} className="kw-chip">
              {k}
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="brief-outline">
          <strong className="small">Outline (builder owns the build)</strong>
          <ol>
            {brief.outline.map((o, i) => (
              <li key={i} className="small">
                <Badge className="bg-gray-100 text-gray-600 text-xs">{o.role}</Badge> {o.notes}
              </li>
            ))}
          </ol>
          {brief.localSignals.length > 0 && (
            <p className="muted small">Local signals: {brief.localSignals.join(", ")}</p>
          )}
        </div>
      )}
      <div className="actions" style={{ margin: 0 }}>
        {brief.status === "pending" && (
          <>
            <button className="chip" onClick={() => setStatus.mutate("accepted")}>
              Accept
            </button>
            <button className="chip" onClick={() => setStatus.mutate("dismissed")}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function BriefsTab({ siteId }: { siteId: string }) {
  const { data } = useQuery({
    queryKey: ["briefs", siteId],
    queryFn: async () => {
      const res = await fetch(`/api/v1/sites/${siteId}/briefs`);
      return (await res.json()) as { briefs: Brief[] };
    },
    refetchInterval: 4000,
  });
  const briefs = (data?.briefs ?? []).filter((b) => b.status !== "dismissed");
  const pending = briefs.filter((b) => b.status === "pending").length;
  return (
    <div>
      {briefs.length === 0 && (
        <div className="preview-empty">
          <p className="muted">
            No page briefs yet — run a keyword cycle (the button above, or “do keyword work” in chat)
            and the brain will brief pages this site should have.
          </p>
        </div>
      )}
      {pending > 0 && (
        <p className="muted small" style={{ marginBottom: 10 }}>
          {pending} brief{pending === 1 ? "" : "s"} awaiting the site builder.
        </p>
      )}
      {briefs.map((b) => (
        <BriefCard key={b.id} brief={b} />
      ))}
    </div>
  );
}
