import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { AdminDb } from "../../db/index.ts";

/**
 * Cross-registry routes: fleet-wide job feed (builds view) and global search
 * (top-bar client/site finder).
 */
export function registerGlobalRoutes(app: FastifyInstance, db: AdminDb): void {
  app.get("/api/v1/jobs", async (req) => {
    const { status, limit: rawLimit } = (req.query ?? {}) as { status?: string; limit?: string };
    const limit = Math.min(Number(rawLimit) || 50, 200);
    let q = db
      .selectFrom("jobs")
      .innerJoin("sites", "sites.id", "jobs.siteId")
      .innerJoin("companies", "companies.id", "jobs.companyId")
      .select([
        "jobs.id",
        "jobs.siteId",
        "jobs.type",
        "jobs.status",
        "jobs.error",
        "jobs.createdAt",
        "jobs.startedAt",
        "jobs.finishedAt",
        "companies.name as companyName",
        "sites.slug as siteSlug",
        "sites.seedType",
      ])
      .orderBy("jobs.createdAt", "desc")
      .limit(limit);
    if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      q = q.where("jobs.status", "in", statuses);
    }
    return { jobs: await q.execute() };
  });

  app.get("/api/v1/search", async (req) => {
    const { q: query } = (req.query ?? {}) as { q?: string };
    const term = (query ?? "").trim().toLowerCase();
    if (term.length < 2) return { workspaces: [], companies: [], sites: [] };
    const like = `%${term.replace(/[%_]/g, "")}%`;

    const workspaces = await db
      .selectFrom("workspaces")
      .select(["id", "name", "status"])
      .where(sql`lower(name)`, "like", like)
      .limit(6)
      .execute();

    const companies = await db
      .selectFrom("companies")
      .innerJoin("workspaces", "workspaces.id", "companies.workspaceId")
      .select(["companies.id", "companies.name", "companies.workspaceId", "workspaces.name as workspaceName"])
      .where(sql`lower(companies.name)`, "like", like)
      .limit(6)
      .execute();

    const sites = await db
      .selectFrom("sites")
      .innerJoin("companies", "companies.id", "sites.companyId")
      .select([
        "sites.id",
        "sites.slug",
        "sites.sourceUrl",
        "sites.status",
        "sites.stage",
        "companies.name as companyName",
      ])
      .where((eb) =>
        eb.or([
          eb(sql`lower(sites.slug)`, "like", like),
          eb(sql`lower(sites.sourceUrl)`, "like", like),
        ]),
      )
      .limit(6)
      .execute();

    return { workspaces, companies, sites, query: term };
  });
}
