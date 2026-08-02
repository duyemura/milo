import type { RunState } from "@milo/clone-engine";

export interface Site {
  id: string;
  workspaceId: string;
  companyId: string;
  seedType: "clone" | "template" | "none";
  sourceUrl: string | null;
  slug: string | null;
  status: string;
  stage: "onboarding" | "building" | "in-review" | "live";
  active: number;
  createdAt: string;
}

export interface Job {
  id: string;
  siteId: string;
  type: string;
  status: "waiting" | "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobLog {
  seq: number;
  jobId: string;
  line: string;
  createdAt: string;
}

export interface SiteDetail {
  site: Site;
  jobs: Job[];
  runState: RunState;
  previewUrl: string | null;
}

export interface ReportDoc {
  report: unknown;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "/auth/login";
    throw new Error("Sign-in required.");
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${method} ${url} failed with ${res.status}.`);
  return data;
}

export const api = {
  listSites: () => req<{ sites: Site[] }>("GET", "/api/v1/sites"),
  siteDetail: (id: string) => req<SiteDetail>("GET", `/api/v1/sites/${id}`),
  /** Clone a site: creates the record and auto-enqueues the clone seed in one call. */
  cloneSite: (companyId: string, sourceUrl: string) =>
    req<{ site: Site; seedJob: { id: string } | null }>("POST", "/api/v1/sites", {
      companyId,
      seedType: "clone",
      sourceUrl,
    }),
  reseed: (id: string, sourceUrl: string) =>
    req<{ seedJob: { id: string } }>("POST", `/api/v1/sites/${id}/seed`, { seedType: "clone", sourceUrl }),
  jobLogs: (jobId: string) => req<{ logs: JobLog[] }>("GET", `/api/v1/jobs/${jobId}/logs`),
  report: (id: string) => req<ReportDoc>("GET", `/api/v1/sites/${id}/report`),
  eventsUrl: (id: string) => `/api/v1/sites/${id}/events`,
  previewUrl: (id: string) => `/sites/${id}/site/`,
};

interface WorkspaceLite { id: string; name: string; }
interface CompanyLite { id: string; name: string; }

/** Ensure a default workspace + company exist so "paste a URL" needs no registry UI. */
export async function ensureDefaultCompany(): Promise<string> {
  const { workspaces } = await req<{ workspaces: WorkspaceLite[] }>("GET", "/api/v1/workspaces");
  let ws = workspaces[0];
  if (!ws) {
    ws = (await req<{ workspace: WorkspaceLite }>("POST", "/api/v1/workspaces", { name: "Workbench" })).workspace;
  }
  const detail = await req<{ companies: CompanyLite[] }>("GET", `/api/v1/workspaces/${ws.id}`);
  const existing = detail.companies[0];
  if (existing) return existing.id;
  const created = await req<{ company: CompanyLite }>("POST", "/api/v1/companies", {
    workspaceId: ws.id,
    companyId: `wb-${Date.now()}`,
    name: "Demo",
  });
  return created.company.id;
}
