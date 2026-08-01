import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Input } from "@pushpress/pushpress-ui";
import { api, type Company, type Site, type Workspace } from "../api.ts";
import { NewSiteForm } from "../components/NewSiteForm.tsx";

function WorkspaceList(props: { selected: string | null; onSelect: (w: Workspace) => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["workspaces"], queryFn: api.listWorkspaces });
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createWorkspace(name.trim()),
    onSuccess: () => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });

  return (
    <section className="pane">
      <h3>Clients</h3>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error.message}</p>}
      <ul className="list">
        {(data?.workspaces ?? []).map((w) => (
          <li key={w.id}>
            <button
              className={`row ${props.selected === w.id ? "selected" : ""}`}
              onClick={() => props.onSelect(w)}
            >
              <span>{w.name}</span>
              <Badge className="bg-gray-100 text-gray-600 text-xs">{w.status}</Badge>
            </button>
          </li>
        ))}
      </ul>
      <form
        className="create"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Input
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          placeholder="New client name"
        />
        <Button type="submit" disabled={create.isPending}>
          Add client
        </Button>
      </form>
      {create.error && <p className="error">{create.error.message}</p>}
    </section>
  );
}

function CompanyList(props: { workspace: Workspace; selected: string | null; onSelect: (c: Company) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["workspaces", props.workspace.id],
    queryFn: () => api.workspaceDetail(props.workspace.id),
  });
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.createCompany({ workspaceId: props.workspace.id, companyId: companyId.trim(), name: name.trim() }),
    onSuccess: () => {
      setName("");
      setCompanyId("");
      void qc.invalidateQueries({ queryKey: ["workspaces", props.workspace.id] });
    },
  });

  return (
    <section className="pane">
      <h3>{props.workspace.name} — gyms</h3>
      <ul className="list">
        {(data?.companies ?? []).map((c) => (
          <li key={c.id}>
            <button
              className={`row ${props.selected === c.id ? "selected" : ""}`}
              onClick={() => props.onSelect(c)}
            >
              <span>{c.name}</span>
              <span className="muted small">{c.companyId}</span>
            </button>
          </li>
        ))}
      </ul>
      <form
        className="create"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && companyId.trim()) create.mutate();
        }}
      >
        <Input
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          placeholder="Gym name"
        />
        <Input
          value={companyId}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCompanyId(e.target.value)}
          placeholder="PushPress company ID"
        />
        <Button type="submit" disabled={create.isPending}>
          Add gym
        </Button>
      </form>
      {create.error && <p className="error">{create.error.message}</p>}
    </section>
  );
}

function SitesPane({ company }: { company: Company }) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["sites", company.id],
    queryFn: () => api.companyDetail(company.id),
    select: (d) => d.sites,
  });
  return (
    <section className="pane wide">
      <h3>{company.name} — websites</h3>
      <NewSiteForm company={company} />
      {(data ?? []).map((s: Site) => (
        <button key={s.id} className="site-row" onClick={() => navigate(`/sites/${s.id}`)}>
          <span>
            <strong>{s.slug ?? s.sourceUrl ?? "Unbuilt site"}</strong>
            <span className="muted small"> · {s.seedType} seed</span>
          </span>
          <span className="site-row-right">
            <Badge className="bg-gray-100 text-gray-600 text-xs">{s.stage}</Badge>
            <Badge
              className={`${
                s.status === "error"
                  ? "bg-red-100 text-red-700"
                  : s.status === "deployed" || s.status === "built"
                    ? "bg-green-100 text-green-700"
                    : "bg-blue-100 text-blue-700"
              } text-xs`}
            >
              {s.status}
            </Badge>
          </span>
        </button>
      ))}
      {(data ?? []).length === 0 && <p className="muted small">No sites yet — create one above.</p>}
    </section>
  );
}

export function ClientsPage() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [company, setCompany] = useState<Company | null>(null);

  return (
    <div className="clients-grid">
      <WorkspaceList
        selected={workspace?.id ?? null}
        onSelect={(w) => {
          setWorkspace(w);
          setCompany(null);
        }}
      />
      {workspace && (
        <CompanyList workspace={workspace} selected={company?.id ?? null} onSelect={setCompany} />
      )}
      {company && <SitesPane key={company.id} company={company} />}
    </div>
  );
}
