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
  openrouterApiKey: z.string().optional(),
  openrouterBaseUrl: z.string().default("https://openrouter.ai/api/v1"),
  chatModel: z.string().default("anthropic/claude-haiku-4.5"),
  gaAccountDisplay: z.string().default("PushPress sites"),
  gaAccountName: z.string().optional(),
  /** POLICY (Dan 2026-08-01): analytics injection is production-only by default;
   *  staging carries no tracking. Override exists for testing only. */
  analyticsOnStaging: z
    .preprocess((v) => v === "true" || v === true, z.boolean())
    .default(false),
  gaPropertyDisplay: z.string().default("PushPress sites · staging"),
  googleServiceAccountJson: z.string().optional(),
  googlePlacesApiKey: z.string().optional(),
  repoRoot: z.string(),
});

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

/** Repo root = apps/admin/src/config.ts → ../../.. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ADMIN_DIR = path.resolve(HERE, "..");

/** Minimal .env loader: KEY=VALUE lines, doesn't override existing env.
 *  Strips matched surrounding quotes like real dotenv ("..." / '...') —
 *  a quoted S3_REGION="us-east-1" once shipped literal quotes into the AWS SDK. */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m || env[m[1]] !== undefined) continue;
    let v = m[2];
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    if (v === "") continue; // empty stays unset so ??-defaults actually kick in
    env[m[1]] = v;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  // apps/admin/.env first (admin-specific overrides win); the shared repo-root
  // .env (WorkOS keys, Places key, etc.) fills in anything still unset.
  loadDotEnv(path.join(ADMIN_DIR, ".env"), env);
  loadDotEnv(path.join(REPO_ROOT, ".env"), env);
  const parsed = AdminConfigSchema.parse({
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
    openrouterApiKey: env["OPENROUTER_API_KEY"],
    openrouterBaseUrl: env["OPENROUTER_BASE_URL"],
    chatModel: env["CHAT_MODEL"],
    gaAccountDisplay: env["GA_ACCOUNT_DISPLAY"],
    gaAccountName: env["GA_ACCOUNT_NAME"],
    analyticsOnStaging: env["ANALYTICS_ON_STAGING"],
    gaPropertyDisplay: env["GA_PROPERTY_DISPLAY"],
    googleServiceAccountJson: env["GOOGLE_SERVICE_ACCOUNT_JSON"],
    googlePlacesApiKey: env["GOOGLE_PLACES_API_KEY"],
    repoRoot: REPO_ROOT,
  });
  // dataDir is shared across a process boundary: the admin process creates the site tree
  // (mkdir/serve) while the clone-engine subprocess — spawned with cwd=repoRoot — writes
  // into it. A relative dataDir resolves against each process's cwd differently, so a build
  // launched from apps/admin created apps/admin/admin-data/… while the engine wrote to
  // repoRoot/admin-data/… → ENOENT. Anchor it to repoRoot so both agree regardless of the
  // launch directory (an absolute DATA_DIR override is preserved as-is).
  return { ...parsed, dataDir: path.resolve(REPO_ROOT, parsed.dataDir) };
}
