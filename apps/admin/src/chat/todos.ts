import type { AdminDb } from "../db/index.ts";
import type { TodoRow } from "../db/types.ts";

export interface SuggestedTodo {
  id: string;
  title: string;
  actionType: "launch-site" | "investigate-job" | "deploy-staging";
  actionPayload: Record<string, string>;
  hint: string;
}

/**
 * Suggestions are DERIVED from live state on every read — nothing to dedupe,
 * nothing to dismiss: a suggestion vanishes the moment the state changes.
 * This is the anti-chat-only fix: the system shows what's worth doing without
 * the admin having to know what to ask for.
 */
export async function deriveSuggestions(db: AdminDb): Promise<SuggestedTodo[]> {
  const suggestions: SuggestedTodo[] = [];

  // Sites ready to launch: onboarding or built-but-not-deployed, no active job.
  const sites = await db
    .selectFrom("sites")
    .innerJoin("companies", "companies.id", "sites.companyId")
    .select(["sites.id", "sites.stage", "sites.status", "sites.slug", "companies.name as companyName"])
    .where("sites.active", "=", 1)
    .where("sites.stage", "in", ["onboarding", "building"])
    .execute();

  const activeJobs = await db
    .selectFrom("jobs")
    .select(["siteId"])
    .where("status", "in", ["waiting", "queued", "running"])
    .execute();
  const busy = new Set(activeJobs.map((j) => j.siteId));

  for (const s of sites) {
    if (busy.has(s.id)) continue;
    if (s.status === "error" || s.stage === "onboarding") continue; // error handled below
    const built = s.status === "built";
    suggestions.push({
      id: `launch-${s.id}`,
      title: `Launch ${s.companyName}${s.slug ? ` (${s.slug}-staging)` : ""}`,
      actionType: built ? "deploy-staging" : "launch-site",
      actionPayload: { siteId: s.id, companyName: s.companyName },
      hint: built ? "Site is built — publish staging to launch." : "Site is ready to build and launch.",
    });
  }

  // Failed jobs worth investigating (latest per site only).
  const failed = await db
    .selectFrom("jobs")
    .innerJoin("companies", "companies.id", "jobs.companyId")
    .select(["jobs.id", "jobs.siteId", "jobs.type", "jobs.error", "companies.name as companyName"])
    .where("jobs.status", "=", "failed")
    .orderBy("jobs.createdAt", "desc")
    .limit(10)
    .execute();
  const seenSite = new Set<string>();
  for (const j of failed) {
    if (seenSite.has(j.siteId)) continue;
    seenSite.add(j.siteId);
    suggestions.push({
      id: `fix-${j.id}`,
      title: `Fix failed ${j.type} for ${j.companyName}`,
      actionType: "investigate-job",
      actionPayload: { jobId: j.id, siteId: j.siteId, companyName: j.companyName },
      hint: j.error ?? "Job failed — worth a look.",
    });
  }

  return suggestions;
}

export async function listManualTodos(db: AdminDb): Promise<TodoRow[]> {
  return db
    .selectFrom("todos")
    .selectAll()
    .where("status", "!=", "dismissed")
    .orderBy("createdAt", "desc")
    .execute();
}
