import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AdminDb } from "../../db/index.ts";
import type { AdminConfig } from "../../config.ts";
import { emitBriefDrop } from "../../jobs/keywordCycle.ts";
import { parse, parseId } from "./schemas.ts";

const setStatusBody = z.object({ status: z.enum(["pending", "accepted", "built", "dismissed"]) });

export function registerBriefRoutes(app: FastifyInstance, db: AdminDb, config: AdminConfig): void {
  app.get("/api/v1/sites/:id/briefs", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const rows = await db
      .selectFrom("page_briefs")
      .selectAll()
      .where("siteId", "=", id)
      .where("status", "!=", "dismissed")
      .orderBy("createdAt", "desc")
      .execute();
    return {
      briefs: rows.map((r) => ({ ...JSON.parse(r.payload), id: r.id, status: r.status, createdAt: r.createdAt })),
    };
  });

  app.get("/api/v1/briefs/:id", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const row = await db.selectFrom("page_briefs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: "Brief not found." });
    return { brief: { ...JSON.parse(row.payload), id: row.id, status: row.status, createdAt: row.createdAt } };
  });

  app.patch("/api/v1/briefs/:id", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const body = parse(setStatusBody, req.body, reply);
    if (!body) return;
    const row = await db.selectFrom("page_briefs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: "Brief not found." });
    await db
      .updateTable("page_briefs")
      .set({ status: body.status, updatedAt: new Date().toISOString() })
      .where("id", "=", id)
      .execute();
    // Builder's drop tracks status changes too.
    await emitBriefDrop(db, config.dataDir, row.siteId);
    return { ok: true, status: body.status };
  });
}
