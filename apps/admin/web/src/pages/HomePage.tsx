import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Badge } from "@pushpress/pushpress-ui";
import { api, ensureDefaultCompany, type Site } from "../api.ts";

export function HomePage() {
  const nav = useNavigate();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api.listSites().then((r) => r.sites) });

  const startClone = async () => {
    setError(null);
    setBusy(true);
    try {
      const companyId = await ensureDefaultCompany();
      const { site } = await api.cloneSite(companyId, url.trim());
      nav(`/sites/${site.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <section className="paste">
        <h1>Clone a website</h1>
        <p className="muted">Paste a URL and watch it rebuild, page by page.</p>
        <div className="paste-row">
          <Input
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && url.trim() && startClone()}
          />
          <Button onClick={startClone} disabled={busy || !url.trim()}>
            {busy ? "Starting…" : "Clone site"}
          </Button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="gallery">
        <h2>Recent builds</h2>
        {sites.isLoading && <p className="muted">Loading…</p>}
        <div className="grid">
          {(sites.data ?? []).map((s) => (
            <GalleryCard key={s.id} site={s} onOpen={() => nav(`/sites/${s.id}`)} />
          ))}
        </div>
      </section>
    </main>
  );
}

type BadgeVariant = "default" | "error" | "destructive" | "outline" | "secondary" | "dark" | "success" | "warning" | "neutral" | "info";

function GalleryCard(props: { site: Site; onOpen: () => void }) {
  const { site, onOpen } = props;
  const variant: BadgeVariant =
    site.status === "built" || site.status === "deployed"
      ? "success"
      : site.status === "error" || site.status === "failed"
        ? "error"
        : "neutral";
  return (
    <button className="card" onClick={onOpen}>
      <div className="card-title">{site.sourceUrl ?? site.slug ?? site.id.slice(0, 8)}</div>
      <Badge variant={variant}>{site.status}</Badge>
    </button>
  );
}
