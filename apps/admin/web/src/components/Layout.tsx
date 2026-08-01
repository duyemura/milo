import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Input } from "@pushpress/pushpress-ui";

interface SearchHit {
  workspaces: { id: string; name: string }[];
  companies: { id: string; name: string; workspaceId: string; workspaceName: string }[];
  sites: { id: string; slug: string | null; sourceUrl: string | null; status: string; stage: string; companyName: string }[];
}

function TopSearch() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit | null>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q.trim())}`);
      setHits(await res.json());
      setOpen(true);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const go = (to: string) => {
    setQ("");
    setOpen(false);
    setHits(null);
    navigate(to);
  };

  return (
    <div className="topsearch">
      <Input
        value={q}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search clients, gyms, sites…"
      />
      {open && hits && (
        <div className="search-results">
          {hits.workspaces.map((w) => (
            <button key={`w${w.id}`} className="hit" onMouseDown={() => go("/clients")}>
              <strong>{w.name}</strong>
              <span className="muted small">client</span>
            </button>
          ))}
          {hits.companies.map((c) => (
            <button key={`c${c.id}`} className="hit" onMouseDown={() => go("/clients")}>
              <strong>{c.name}</strong>
              <span className="muted small">gym · {c.workspaceName}</span>
            </button>
          ))}
          {hits.sites.map((s) => (
            <button key={`s${s.id}`} className="hit" onMouseDown={() => go(`/sites/${s.id}`)}>
              <strong>{s.slug ?? s.sourceUrl}</strong>
              <span className="muted small">
                {s.companyName} · {s.stage}
              </span>
            </button>
          ))}
          {hits.workspaces.length + hits.companies.length + hits.sites.length === 0 && (
            <p className="muted small" style={{ padding: 8 }}>
              Nothing matches “{q}”.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const [authMode, setAuthMode] = useState<string>("");
  useEffect(() => {
    void fetch("/auth/config")
      .then((r) => r.json())
      .then((d: { mode: string }) => setAuthMode(d.mode));
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>Milo</strong>
          <span className="muted small">admin</span>
        </div>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/clients">Clients</NavLink>
          <NavLink to="/builds">Builds</NavLink>
        </nav>
        <div className="sidebar-foot muted small">
          {authMode === "workos" ? <a href="/auth/logout">Sign out</a> : "dev mode"}
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div />
          <TopSearch />
        </header>
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
