export interface Workspace {
  id: string;
  name: string;
  contact: string | null;
  status: string;
  createdAt: string;
}

export interface Company {
  id: string;
  workspaceId: string;
  companyId: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface Site {
  id: string;
  workspaceId: string;
  companyId: string;
  seedType: "clone" | "template";
  sourceUrl: string | null;
  slug: string | null;
  status: string;
  active: number;
  createdAt: string;
}

export interface Job {
  id: string;
  siteId: string;
  type: string;
  status: "waiting" | "queued" | "running" | "succeeded" | "failed";
  payload: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Deploy {
  id: string;
  env: "staging" | "production";
  url: string | null;
  status: string;
  createdAt: string;
}

export interface SiteDetail {
  site: Site;
  jobs: Job[];
  deploys: Deploy[];
  previewUrl: string | null;
}

export interface JobLog {
  seq: number;
  jobId: string;
  line: string;
  createdAt: string;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // WorkOS mode: session expired/absent → hosted login.
    window.location.href = "/auth/login";
    throw new Error("Sign-in required.");
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${method} ${url} failed with ${res.status}.`);
  return data;
}

export const api = {
  listWorkspaces: () => req<{ workspaces: Workspace[] }>("GET", "/api/v1/workspaces"),
  createWorkspace: (name: string) =>
    req<{ workspace: Workspace }>("POST", "/api/v1/workspaces", { name }),
  workspaceDetail: (id: string) =>
    req<{ workspace: Workspace; companies: Company[] }>("GET", `/api/v1/workspaces/${id}`),
  createCompany: (b: { workspaceId: string; companyId: string; name: string }) =>
    req<{ company: Company }>("POST", "/api/v1/companies", b),
  companyDetail: (id: string) =>
    req<{ company: Company; sites: Site[] }>("GET", `/api/v1/companies/${id}`),
  createSite: (b: {
    companyId: string;
    seedType: "template";
    sourceUrl: string;
    name: string;
    city: string;
    state: string;
    templateId?: string;
  }) => req<{ site: Site; seedJob: { id: string } }>("POST", "/api/v1/sites", b),
  siteDetail: (id: string) => req<SiteDetail>("GET", `/api/v1/sites/${id}`),
  triggerJob: (siteId: string, type: string) =>
    req<{ job: { id: string; status: string; queuePosition: number } }>(
      "POST",
      `/api/v1/sites/${siteId}/jobs`,
      { type },
    ),
  jobLogs: (jobId: string) => req<{ logs: JobLog[] }>("GET", `/api/v1/jobs/${jobId}/logs`),
};
