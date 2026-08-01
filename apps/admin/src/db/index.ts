import { Kysely, Migrator, type MigrationProvider, type Migration } from "kysely";
import type { Database } from "./types.ts";
import { migrations } from "./migrations.ts";
import { NodeSqliteDialect } from "./node-sqlite-dialect.ts";

export type AdminDb = Kysely<Database>;

export function createDb(dbPath: string): AdminDb {
  return new Kysely<Database>({
    dialect: new NodeSqliteDialect(dbPath),
  });
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
