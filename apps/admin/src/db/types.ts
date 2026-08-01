export interface WorkspaceRow {
  id: string;
  name: string;
  contact: string | null;
  status: "active" | "archived";
  createdAt: string;
}

export interface CompanyRow {
  id: string;
  workspaceId: string;
  companyId: string;
  name: string;
  status: "active" | "archived";
  createdAt: string;
}

export type SeedType = "clone" | "template";
export type SiteStatus = "registered" | "seeding" | "seeded" | "built" | "deployed" | "error";

export interface SiteRow {
  id: string;
  workspaceId: string;
  companyId: string;
  seedType: SeedType;
  sourceUrl: string | null;
  slug: string | null;
  status: SiteStatus;
  active: number;
  createdAt: string;
}

export type JobType = "seed" | "build" | "deploy-staging" | "promote" | "rollback";
export type JobStatus = "waiting" | "queued" | "running" | "succeeded" | "failed";

export interface JobRow {
  id: string;
  workspaceId: string;
  companyId: string;
  siteId: string;
  type: JobType;
  status: JobStatus;
  payload: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DeployRow {
  id: string;
  workspaceId: string;
  companyId: string;
  siteId: string;
  env: "staging" | "production";
  versionId: string | null;
  url: string | null;
  status: "deployed" | "rolled-back";
  createdAt: string;
}

export interface JobLogRow {
  seq: number;
  jobId: string;
  line: string;
  createdAt: string;
}

export interface Database {
  workspaces: WorkspaceRow;
  companies: CompanyRow;
  sites: SiteRow;
  jobs: JobRow;
  deploys: DeployRow;
  job_logs: JobLogRow;
}
