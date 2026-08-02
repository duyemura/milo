import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AdminDb } from "../../db/index.ts";
import type { EngineQueue } from "../../jobs/dispatch.ts";
import type { RunHub } from "../../jobs/run-state.ts";
import { enqueueJob, queuePosition } from "../../jobs/dispatch.ts";
import { createJobBody, createSiteBody, parse, parseId, setStageBody } from "./schemas.ts";

export function registerSiteRoutes(app: FastifyInstance, db: AdminDb, queue: EngineQueue, hub: RunHub): void {
  app.get("/api/v1/sites", async (req) => {
    const { companyId } = (req.query ?? {}) as { companyId?: string };
    let q = db.selectFrom("sites").selectAll().orderBy("createdAt", "desc");
    if (companyId) q = q.where("companyId", "=", companyId);
    return { sites: await q.execute() };
  });

  app.post("/api/v1/sites", async (req, reply) => {
    const body = parse(createSiteBody, req.body, reply);
    if (!body) return;
    const company = await db
      .selectFrom("companies")
      .selectAll()
      .where("id", "=", body.companyId)
      .executeTakeFirst();
    if (!company) {
      return reply.code(400).send({ error: "companyId must reference an existing company." });
    }
    if (body.seedType === "template" && (!body.sourceUrl || !body.name || !body.city || !body.state)) {
      return reply
        .code(400)
        .send({ error: "Template seed requires sourceUrl, name, city, and state." });
    }
    if (body.seedType === "clone" && !body.sourceUrl) {
      return reply.code(400).send({ error: "Clone seed requires sourceUrl." });
    }

    // Deactivate previous sites for this company — one is `active`.
    await db.updateTable("sites").set({ active: 0 }).where("companyId", "=", company.id).execute();

    const site = {
      id: randomUUID(),
      workspaceId: company.workspaceId,
      companyId: company.id,
      seedType: body.seedType,
      sourceUrl: body.sourceUrl ?? null,
      slug: null,
      status: "registered" as const,
      stage: "onboarding" as const,
      active: 1,
      createdAt: new Date().toISOString(),
    };
    await db.insertInto("sites").values(site).execute();

    const job = await enqueueJob(db, queue, {
      siteId: site.id,
      workspaceId: site.workspaceId,
      companyId: site.companyId,
      type: "seed",
      payload: {
        sourceUrl: body.sourceUrl ?? "",
        name: body.name ?? "",
        city: body.city ?? "",
        state: body.state ?? "",
        templateId: body.templateId ?? "modern",
      },
    });
    await db.updateTable("sites").set({ status: "seeding" }).where("id", "=", site.id).execute();

    return reply.code(201).send({
      site: { ...site, status: "seeding" },
      seedJob: { id: job.id, status: job.status, queuePosition: await queuePosition(db, job) },
    });
  });

  app.get("/api/v1/sites/:id", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const site = await db
      .selectFrom("sites")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!site) {
      return reply.code(404).send({ error: "Site not found." });
    }
    const jobs = await db
      .selectFrom("jobs")
      .selectAll()
      .where("siteId", "=", id)
      .orderBy("createdAt", "desc")
      .limit(20)
      .execute();
    const deploys = await db
      .selectFrom("deploys")
      .selectAll()
      .where("siteId", "=", id)
      .orderBy("createdAt", "desc")
      .limit(10)
      .execute();
    const latestStaging = deploys.find((d) => d.env === "staging" && d.url);
    const connections = await db
      .selectFrom("google_connections")
      .selectAll()
      .where("siteId", "=", id)
      .execute();
    const metrics = await db
      .selectFrom("site_metrics")
      .selectAll()
      .where("siteId", "=", id)
      .orderBy("collectedAt", "desc")
      .limit(200)
      .execute();
    // Latest value per (source, metric) for the Signals tab.
    interface MetricValue {
      value: string;
      collectedAt: string;
      dimensions: Record<string, unknown>;
    }
    const latest: Record<string, MetricValue> = {};
    for (const m of metrics) {
      const key = `${m.source}:${m.metric}`;
      if (!latest[key]) {
        latest[key] = { value: m.value, collectedAt: m.collectedAt, dimensions: JSON.parse(m.dimensions) as Record<string, unknown> };
      }
    }
    return {
      site,
      jobs,
      deploys,
      connections,
      metricsLatest: latest,
      previewUrl: site.slug ? `https://${site.slug}-staging.mygymseo.com` : (latestStaging?.url ?? null),
    };
  });

  app.post("/api/v1/sites/:id/jobs", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const body = parse(createJobBody, req.body, reply);
    if (!body) return;
    const site = await db
      .selectFrom("sites")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!site) {
      return reply.code(404).send({ error: "Site not found." });
    }
    const job = await enqueueJob(db, queue, {
      siteId: site.id,
      workspaceId: site.workspaceId,
      companyId: site.companyId,
      type: body.type,
      payload: body.payload,
    });
    return reply
      .code(202)
      .send({ job: { id: job.id, status: job.status, queuePosition: await queuePosition(db, job) } });
  });

  app.get("/api/v1/sites/:id/jobs", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const jobs = await db
      .selectFrom("jobs")
      .selectAll()
      .where("siteId", "=", id)
      .orderBy("createdAt", "desc")
      .execute();
    return { jobs };
  });

  app.patch("/api/v1/sites/:id/stage", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const body = parse(setStageBody, req.body, reply);
    if (!body) return;
    const updated = await db
      .updateTable("sites")
      .set({ stage: body.stage })
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      return reply.code(404).send({ error: "Site not found." });
    }
    const site = await db.selectFrom("sites").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    return { site };
  });
}
