import type { FastifyInstance } from "fastify";
import type { AdminDb } from "../../db/index.ts";
import { parseId } from "./schemas.ts";

export function registerJobLogRoutes(app: FastifyInstance, db: AdminDb): void {
  app.get("/api/v1/jobs/:id", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const job = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!job) {
      return reply.code(404).send({ error: "Job not found." });
    }
    return { job };
  });

  app.get("/api/v1/jobs/:id/logs", async (req, reply) => {
    const id = parseId(req.params, reply);
    if (!id) return;
    const logs = await db
      .selectFrom("job_logs")
      .selectAll()
      .where("jobId", "=", id)
      .orderBy("seq", "asc")
      .execute();
    return { logs };
  });
}
