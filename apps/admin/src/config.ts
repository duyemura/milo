import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const AdminConfigSchema = z.object({
  port: z.coerce.number().default(4100),
  host: z.string().default("127.0.0.1"),
  dbPath: z.string().default("./admin.db"),
  dbUrl: z.string().optional(),
  dataDir: z.string().default("./admin-data"),
  redisUrl: z.string().default("redis://localhost:6379"),
  queueDriver: z.enum(["local", "bullmq"]).default("local"),
  authMode: z.enum(["dev", "workos"]).default("dev"),
  workosApiKey: z.string().optional(),
  workosClientId: z.string().optional(),
  workosCookiePassword: z.string().optional(),
  workosRedirectUri: z.string().default("http://127.0.0.1:4100/auth/callback"),
  allowedEmailDomain: z.string().default("pushpress.com"),
  repoRoot: z.string(),
});

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

/** Repo root = apps/admin/src/config.ts → ../../.. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ADMIN_DIR = path.resolve(HERE, "..");

/** Minimal .env loader: KEY=VALUE lines, doesn't override existing env. */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  // apps/admin/.env first (admin-specific overrides win); the shared repo-root
  // .env (WorkOS keys, Places key, etc.) fills in anything still unset.
  loadDotEnv(path.join(ADMIN_DIR, ".env"), env);
  loadDotEnv(path.join(REPO_ROOT, ".env"), env);
  return AdminConfigSchema.parse({
    port: env["PORT"],
    host: env["HOST"],
    dbPath: env["DB_PATH"],
    dbUrl: env["DATABASE_URL"],
    dataDir: env["DATA_DIR"],
    redisUrl: env["REDIS_URL"],
    queueDriver: env["QUEUE_DRIVER"],
    authMode: env["AUTH_MODE"],
    workosApiKey: env["WORKOS_API_KEY"],
    workosClientId: env["WORKOS_CLIENT_ID"],
    workosCookiePassword: env["WORKOS_COOKIE_PASSWORD"],
    workosRedirectUri: env["WORKOS_REDIRECT_URI"],
    allowedEmailDomain: env["ALLOWED_EMAIL_DOMAIN"],
    repoRoot: REPO_ROOT,
  });
}
