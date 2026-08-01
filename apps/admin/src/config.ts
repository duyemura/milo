import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const AdminConfigSchema = z.object({
  port: z.coerce.number().default(4100),
  host: z.string().default("127.0.0.1"),
  dbPath: z.string().default("./admin.db"),
  dataDir: z.string().default("./admin-data"),
  redisUrl: z.string().default("redis://localhost:6379"),
  queueDriver: z.enum(["local", "bullmq"]).default("local"),
  authMode: z.enum(["dev", "google"]).default("dev"),
  jwtSecret: z.string().default("admin-dev-secret"),
  googleClientId: z.string().optional(),
  repoRoot: z.string(),
});

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

/** Repo root = apps/admin/src/config.ts → ../../.. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  return AdminConfigSchema.parse({
    port: env["PORT"],
    host: env["HOST"],
    dbPath: env["DB_PATH"],
    dataDir: env["DATA_DIR"],
    redisUrl: env["REDIS_URL"],
    queueDriver: env["QUEUE_DRIVER"],
    authMode: env["AUTH_MODE"],
    jwtSecret: env["JWT_SECRET"],
    googleClientId: env["GOOGLE_CLIENT_ID"],
    repoRoot: REPO_ROOT,
  });
}
