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

/**
 * Business pipeline stage (distinct from technical status): the journey
 * sales → onboarding → build → client review → live that the dashboard tracks.
 * Auto-advanced by job outcomes; overridable by the team.
 */
export type SiteStage = "onboarding" | "building" | "in-review" | "live";

export interface SiteRow {
  id: string;
  workspaceId: string;
  companyId: string;
  seedType: SeedType;
  sourceUrl: string | null;
  slug: string | null;
  status: SiteStatus;
  stage: SiteStage;
  active: number;
  createdAt: string;
}

export type JobType = "seed" | "build" | "deploy-staging" | "promote" | "rollback" | "keyword-cycle" | "measure";
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
  result: string | null;
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

export interface TodoRow {
  id: string;
  siteId: string | null;
  companyId: string | null;
  title: string;
  actionType: string | null;
  actionPayload: string;
  status: "open" | "done" | "dismissed";
  assignee: string;
  createdAt: string;
  doneAt: string | null;
}

export interface PageBriefRow {
  id: string;
  workspaceId: string;
  companyId: string;
  siteId: string;
  /** Full PageBrief JSON (handshake contract, zod from @milo/keyword-brain). */
  payload: string;
  status: "pending" | "accepted" | "built" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

export interface GoogleConnectionRow {
  id: string;
  workspaceId: string;
  companyId: string;
  siteId: string;
  kind: "gsc" | "ga4" | "gbp" | "places";
  externalId: string | null;
  status: "pending" | "active" | "error";
  meta: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteMetricRow {
  id: string;
  workspaceId: string;
  companyId: string;
  siteId: string;
  source: string;
  metric: string;
  dimensions: string;
  value: string;
  collectedAt: string;
}

export interface Database {
  workspaces: WorkspaceRow;
  companies: CompanyRow;
  sites: SiteRow;
  jobs: JobRow;
  deploys: DeployRow;
  job_logs: JobLogRow;
  todos: TodoRow;
  page_briefs: PageBriefRow;
  google_connections: GoogleConnectionRow;
  site_metrics: SiteMetricRow;
}
