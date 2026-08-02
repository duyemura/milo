import path from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { AdminConfig } from "../config.ts";
import type { AdminDb } from "../db/index.ts";
import type { EngineQueue } from "../jobs/dispatch.ts";
import { registerAuth } from "../auth/plugin.ts";
import { registerHealth } from "./routes/health.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { registerCompanyRoutes } from "./routes/companies.ts";
import { registerSiteRoutes } from "./routes/sites.ts";
import { registerJobLogRoutes } from "./routes/jobLogs.ts";
import { registerGlobalRoutes } from "./routes/global.ts";

export interface AppDeps {
  config: AdminConfig;
  db: AdminDb;
  queue: EngineQueue;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, queue } = deps;
  const app = Fastify({ logger: config.authMode !== "dev" });

  await app.register(cookie);

  registerAuth(app, config);
  registerHealth(app);
  registerWorkspaceRoutes(app, db);
  registerCompanyRoutes(app, db);
  registerSiteRoutes(app, db, queue);
  registerJobLogRoutes(app, db);
  registerGlobalRoutes(app, db);

  // Serve the built SPA; dev uses vite (dev:web) instead.
  const webDist = path.join(path.resolve(), "web", "dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/auth/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found." });
    });
  }

  return app;
}
