import { Kysely, Migrator, PostgresDialect, type MigrationProvider, type Migration } from "kysely";
import { Pool } from "pg";
import type { Database } from "./types.ts";
import { migrations } from "./migrations.ts";
import { NodeSqliteDialect } from "./node-sqlite-dialect.ts";

export type AdminDb = Kysely<Database>;

/**
 * SQLite (node:sqlite) for local/dev — set DATABASE_URL to a postgres:// URL for
 * deployment. Same migrations, same code; the dialect is the only thing that changes.
 */
export function createDb(opts: string | { dbUrl?: string; dbPath?: string }): AdminDb {
  if (typeof opts === "string") return new Kysely<Database>({ dialect: new NodeSqliteDialect(opts) });
  if (opts.dbUrl) {
    return new Kysely<Database>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: opts.dbUrl }) }),
    });
  }
  return new Kysely<Database>({ dialect: new NodeSqliteDialect(opts.dbPath ?? "./admin.db") });
}

export async function migrateToLatest(db: AdminDb): Promise<void> {
  const provider: MigrationProvider = {
    getMigrations: () => Promise.resolve(migrations as Record<string, Migration>),
  };
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  for (const r of results ?? []) {
    if (r.status === "Error") throw new Error(`migration ${r.migrationName} failed`);
  }
}
