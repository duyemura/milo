import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Input } from "@pushpress/pushpress-ui";
import { api, type Company, type Workspace } from "./api.ts";
import { SiteCard } from "./components/SiteCard.tsx";
import { NewSiteForm } from "./components/NewSiteForm.tsx";

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
      <h2>Clients</h2>
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
      <h2>{props.workspace.name} — gyms</h2>
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
  const { data } = useQuery({
    queryKey: ["sites", company.id],
    queryFn: () => api.companyDetail(company.id),
    select: (d) => d.sites,
  });
  return (
    <section className="pane wide">
      <h2>{company.name} — websites</h2>
      <NewSiteForm company={company} />
      {(data ?? []).map((s) => (
        <SiteCard key={s.id} site={s} />
      ))}
    </section>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const { data: authConfig } = useQuery({
    queryKey: ["auth-config"],
    queryFn: async () => {
      const res = await fetch("/auth/config");
      return (await res.json()) as { mode: "dev" | "workos"; allowedEmailDomain: string };
    },
    staleTime: Infinity,
  });

  return (
    <div className="shell">
      <header>
        <h1>Milo admin</h1>
        <span className="muted">Website control plane</span>
        <span style={{ marginLeft: "auto" }} className="muted small">
          {authConfig?.mode === "workos" && <a href="/auth/logout">Sign out</a>}
          {authConfig?.mode === "dev" && "dev mode"}
        </span>
      </header>
      <main>
        <WorkspaceList
          selected={workspace?.id ?? null}
          onSelect={(w) => {
            setWorkspace(w);
            setCompany(null);
          }}
        />
        {workspace && (
          <CompanyList
            workspace={workspace}
            selected={company?.id ?? null}
            onSelect={setCompany}
          />
        )}
        {company && <SitesPane key={company.id} company={company} />}
      </main>
    </div>
  );
}
