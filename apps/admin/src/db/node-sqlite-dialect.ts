import { DatabaseSync } from "node:sqlite";
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from "kysely";

/**
 * Kysely dialect over Node 24's built-in node:sqlite — no native build step, which keeps
 * admin installs boring on every teammate's machine. Row detection uses
 * StatementSync.columns() (empty for non-row statements); INSERT…RETURNING still uses .all().
 */
export class NodeSqliteDialect implements Dialect {
  constructor(private readonly dbPath: string) {}
  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }
  createDriver(): Driver {
    return new NodeSqliteDriver(this.dbPath);
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
}

class NodeSqliteDriver implements Driver {
  private db?: DatabaseSync;
  private conn?: NodeSqliteConnection;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    this.db = new DatabaseSync(this.dbPath);
    this.conn = new NodeSqliteConnection(this.db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.conn) throw new Error("driver not initialized");
    return this.conn;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    this.db?.close();
  }
}

class NodeSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: DatabaseSync) {}

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.db.prepare(sql);
    const params = parameters as (string | number | bigint | null | Uint8Array)[];

    if (stmt.columns().length > 0) {
      const rows = stmt.all(...params) as Record<string, unknown>[];
      // node:sqlite returns null-prototype rows; hydrate so Kysely consumers and
      // test assertions see plain objects.
      const plain = rows.map((r) => ({ ...r })) as O[];
      return { rows: plain };
    }

    const { changes, lastInsertRowid } = stmt.run(...params);
    return {
      rows: [],
      numAffectedRows: typeof changes === "bigint" ? changes : BigInt(changes),
      insertId: typeof lastInsertRowid === "bigint" && lastInsertRowid > 0n ? lastInsertRowid : undefined,
    };
  }

  // SQLite is synchronous + single-connection; result streaming is unsupported.
  async *streamQuery(): AsyncGenerator<never> {
    throw new Error("node:sqlite dialect does not support streaming");
  }
}
