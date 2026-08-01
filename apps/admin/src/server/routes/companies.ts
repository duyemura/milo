import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AdminDb } from "../../db/index.ts";
import { createCompanyBody, parse, parseId } from "./schemas.ts";

export function registerCompanyRoutes(app: FastifyInstance, db: AdminDb): void {
  app.get("/api/v1/companies", async (req) => {
    const { workspaceId } = (req.query ?? {}) as { workspaceId?: string };
    let q = db.selectFrom("companies").selectAll().orderBy("createdAt", "desc");
    if (workspaceId) q = q.where("workspaceId", "=", workspaceId);
    return { companies: await q.execute() };
  });

  app.post("/api/v1/companies", async (req, reply) => {
    const body = parse(createCompanyBody, req.body, reply);
    if (!body) return;
    const ws = await db
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", body.workspaceId)
      .executeTakeFirst();
    if (!ws) {
      return reply.code(400).send({ error: "workspaceId must reference an existing workspace." });
    }
    const row = {
      id: randomUUID(),
      workspaceId: body.workspaceId,
      companyId: body.companyId,
      name: body.name,
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    await db.insertInto("companies").values(row).execute();
    return reply.code(201).send({ company: row });
  });

  app.get("/api/v1/companies/:id", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const company = await db
      .selectFrom("companies")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!company) {
      return reply.code(404).send({ error: "Company not found." });
    }
    const sites = await db
      .selectFrom("sites")
      .selectAll()
      .where("companyId", "=", company.id)
      .orderBy("createdAt", "desc")
      .execute();
    return { company, sites };
  });
}
