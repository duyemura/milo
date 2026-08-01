import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AdminDb } from "../../db/index.ts";
import { createWorkspaceBody, parse, parseId } from "./schemas.ts";

export function registerWorkspaceRoutes(app: FastifyInstance, db: AdminDb): void {
  app.get("/api/v1/workspaces", async () => {
    const workspaces = await db
      .selectFrom("workspaces")
      .selectAll()
      .orderBy("createdAt", "desc")
      .execute();
    return { workspaces };
  });

  app.post("/api/v1/workspaces", async (req, reply) => {
    const body = parse(createWorkspaceBody, req.body, reply);
    if (!body) return;
    const row = {
      id: randomUUID(),
      name: body.name,
      contact: body.contact ?? null,
      status: "active" as const,
      createdAt: new Date().toISOString(),
    };
    await db.insertInto("workspaces").values(row).execute();
    return reply.code(201).send({ workspace: row });
  });

  app.get("/api/v1/workspaces/:id", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const workspace = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!workspace) {
      return reply.code(404).send({ error: "Workspace not found." });
    }
    const companies = await db
      .selectFrom("companies")
      .selectAll()
      .where("workspaceId", "=", id)
      .orderBy("createdAt", "desc")
      .execute();
    return { workspace, companies };
  });
}
