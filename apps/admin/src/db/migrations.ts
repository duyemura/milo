import type { Kysely } from "kysely";

const migration1 = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("workspaces")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("contact", "text")
      .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
      .addColumn("createdAt", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("companies")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("workspaceId", "text", (c) => c.notNull().references("workspaces.id"))
      .addColumn("companyId", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
      .addColumn("createdAt", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("sites")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("workspaceId", "text", (c) => c.notNull().references("workspaces.id"))
      .addColumn("companyId", "text", (c) => c.notNull().references("companies.id"))
      .addColumn("seedType", "text", (c) => c.notNull())
      .addColumn("sourceUrl", "text")
      .addColumn("slug", "text")
      .addColumn("status", "text", (c) => c.notNull().defaultTo("registered"))
      .addColumn("active", "integer", (c) => c.notNull().defaultTo(1))
      .addColumn("createdAt", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("jobs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("workspaceId", "text", (c) => c.notNull())
      .addColumn("companyId", "text", (c) => c.notNull())
      .addColumn("siteId", "text", (c) => c.notNull().references("sites.id"))
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull().defaultTo("waiting"))
      .addColumn("payload", "text", (c) => c.notNull().defaultTo("{}"))
      .addColumn("error", "text")
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addColumn("startedAt", "text")
      .addColumn("finishedAt", "text")
      .execute();

    await db.schema
      .createTable("deploys")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("workspaceId", "text", (c) => c.notNull())
      .addColumn("companyId", "text", (c) => c.notNull())
      .addColumn("siteId", "text", (c) => c.notNull().references("sites.id"))
      .addColumn("env", "text", (c) => c.notNull())
      .addColumn("versionId", "text")
      .addColumn("url", "text")
      .addColumn("status", "text", (c) => c.notNull().defaultTo("deployed"))
      .addColumn("createdAt", "text", (c) => c.notNull())
      .execute();

    // seq is per-job and assigned by appendLog (SELECT max+1) — portable across
    // SQLite and Postgres, no dialect-specific autoincrement needed.
    await db.schema
      .createTable("job_logs")
      .addColumn("jobId", "text", (c) => c.notNull().references("jobs.id"))
      .addColumn("seq", "integer", (c) => c.notNull())
      .addColumn("line", "text", (c) => c.notNull())
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("job_logs_pk", ["jobId", "seq"])
      .execute();

    await db.schema.createIndex("jobs_site_status").on("jobs").columns(["siteId", "status"]).execute();
    await db.schema.createIndex("job_logs_job").on("job_logs").columns(["jobId"]).execute();
  },
  async down(db: Kysely<unknown>) {
    for (const t of ["job_logs", "deploys", "jobs", "sites", "companies", "workspaces"]) {
      await db.schema.dropTable(t).execute();
    }
  },
};

const migration2 = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable("sites")
      .addColumn("stage", "text", (c) => c.notNull().defaultTo("onboarding"))
      .execute();
    await db.schema.createIndex("sites_stage").on("sites").columns(["stage"]).execute();
  },
  async down(db: Kysely<unknown>) {
    await db.schema.alterTable("sites").dropColumn("stage").execute();
  },
};

const migration3 = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("todos")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("siteId", "text")
      .addColumn("companyId", "text")
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("actionType", "text")
      .addColumn("actionPayload", "text", (c) => c.notNull().defaultTo("{}"))
      .addColumn("status", "text", (c) => c.notNull().defaultTo("open"))
      .addColumn("assignee", "text", (c) => c.notNull().defaultTo("team"))
      .addColumn("createdAt", "text", (c) => c.notNull())
      .addColumn("doneAt", "text")
      .execute();
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("todos").execute();
  },
};

export const migrations: Record<string, { up: typeof migration1.up; down: typeof migration1.down }> = {
  migration1,
  migration2,
  migration3,
};
