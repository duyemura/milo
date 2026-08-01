import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { AdminDb } from "../db/index.ts";
import type { EngineQueue } from "../jobs/dispatch.ts";
import { enqueueJob } from "../jobs/dispatch.ts";
import type { SiteStage } from "../db/types.ts";

export interface ChatAction {
  type:
    | "createWorkspace"
    | "createCompany"
    | "createSite"
    | "updateSite"
    | "triggerJob"
    | "setStage"
    | "addTodo"
    | "completeTodo"
    | "none";
  args: Record<string, string>;
}

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
}

const now = () => new Date().toISOString();

async function findSite(db: AdminDb, query: string) {
  const like = `%${query.toLowerCase()}%`;
  return db
    .selectFrom("sites")
    .innerJoin("companies", "companies.id", "sites.companyId")
    .selectAll("sites")
    .select("companies.name as companyName")
    .where((eb) =>
      eb.or([
        eb("sites.id", "=", query),
        eb("sites.slug", "=", query),
        eb(sql`lower(sites.slug)`, "like", like),
        eb(sql`lower(sites.sourceUrl)`, "like", like),
        eb(sql`lower(companies.name)`, "like", like),
      ]),
    )
    .orderBy("sites.createdAt", "desc")
    .executeTakeFirst();
}

/** Execute a chat action against the registry. Same code path the REST routes use. */
export async function executeAction(
  db: AdminDb,
  queue: EngineQueue,
  actor: string,
  action: ChatAction,
): Promise<ActionResult> {
  const a = action.args;

  switch (action.type) {
    case "createWorkspace": {
      if (!a["name"]) return { type: action.type, ok: false, detail: "Missing name." };
      const id = randomUUID();
      await db
        .insertInto("workspaces")
        .values({ id, name: a["name"], contact: null, status: "active", createdAt: now() })
        .execute();
      return { type: action.type, ok: true, detail: `Client “${a["name"]}” created.` };
    }

    case "createCompany": {
      const name = a["name"];
      const companyId = a["companyId"];
      if (!name || !companyId) return { type: action.type, ok: false, detail: "Need name + PushPress company ID." };
      const ws = a["workspaceId"]
        ? await db.selectFrom("workspaces").selectAll().where("id", "=", a["workspaceId"]).executeTakeFirst()
        : await db
            .selectFrom("workspaces")
            .selectAll()
            .orderBy("createdAt", "desc")
            .limit(1)
            .executeTakeFirst();
      if (!ws) return { type: action.type, ok: false, detail: "No client workspace to attach the gym to." };
      const id = randomUUID();
      await db
        .insertInto("companies")
        .values({ id, workspaceId: ws.id, companyId, name, status: "active", createdAt: now() })
        .execute();
      return { type: action.type, ok: true, detail: `Gym “${name}” registered under ${ws.name}.` };
    }

    case "createSite": {
      const company = a["companyId"]
        ? await db.selectFrom("companies").selectAll().where("id", "=", a["companyId"]).executeTakeFirst()
        : await db
            .selectFrom("companies")
            .selectAll()
            .where(sql`lower(name)`, "like", `%${(a["company"] ?? "").toLowerCase()}%`)
            .executeTakeFirst();
      if (!company) return { type: action.type, ok: false, detail: `Couldn't find gym “${a["company"] ?? ""}”.` };
      if (!a["sourceUrl"] || !a["name"] || !a["city"] || !a["state"]) {
        return { type: action.type, ok: false, detail: "Need sourceUrl, name, city, and state to build a site." };
      }
      await db.updateTable("sites").set({ active: 0 }).where("companyId", "=", company.id).execute();
      const siteId = randomUUID();
      await db
        .insertInto("sites")
        .values({
          id: siteId,
          workspaceId: company.workspaceId,
          companyId: company.id,
          seedType: "template",
          sourceUrl: a["sourceUrl"],
          slug: null,
          status: "seeding",
          stage: "onboarding",
          active: 1,
          createdAt: now(),
        })
        .execute();
      await enqueueJob(db, queue, {
        siteId,
        workspaceId: company.workspaceId,
        companyId: company.id,
        type: "seed",
        payload: { sourceUrl: a["sourceUrl"], name: a["name"], city: a["city"], state: a["state"], templateId: a["templateId"] ?? "modern" },
      });
      return { type: action.type, ok: true, detail: `Site for ${company.name} queued for build (seed job started).` };
    }

    case "updateSite": {
      // Chat-learned state changes: "that URL was wrong — it's torrancegym.com, retry".
      // Updates the site, optionally re-seeds with the corrected payload.
      const site = await findSite(db, a["site"] ?? "");
      if (!site) return { type: action.type, ok: false, detail: `Couldn't find site “${a["site"] ?? ""}”.` };
      const updates: Record<string, string> = {};
      if (a["sourceUrl"]) updates["sourceUrl"] = a["sourceUrl"];
      await db.updateTable("sites").set(updates).where("id", "=", site.id).execute();
      const changed = Object.keys(updates).length > 0;
      if (!changed && !a["reseed"]) {
        return { type: action.type, ok: false, detail: "Nothing to update — pass sourceUrl (and/or reseed)." };
      }

      if (!a["reseed"]) {
        return { type: action.type, ok: true, detail: `Updated site — sourceUrl is now ${a["sourceUrl"]}.` };
      }

      // Re-seed needs a full payload; inherit the last seed job's and overlay corrections.
      const lastSeed = await db
        .selectFrom("jobs")
        .selectAll()
        .where("siteId", "=", site.id)
        .where("type", "=", "seed")
        .orderBy("createdAt", "desc")
        .executeTakeFirst();
      const base = lastSeed ? (JSON.parse(lastSeed.payload) as Record<string, string>) : {};
      const payload = {
        sourceUrl: a["sourceUrl"] ?? base["sourceUrl"] ?? site.sourceUrl ?? "",
        name: a["name"] ?? base["name"],
        city: a["city"] ?? base["city"],
        state: a["state"] ?? base["state"],
        templateId: a["templateId"] ?? base["templateId"] ?? "modern",
      };
      if (!payload.sourceUrl || !payload.name || !payload.city || !payload.state) {
        return {
          type: action.type,
          ok: false,
          detail: "Re-seed needs sourceUrl, name, city, and state — tell me the missing values.",
        };
      }
      await db.updateTable("sites").set({ status: "seeding", stage: "onboarding" }).where("id", "=", site.id).execute();
      await enqueueJob(db, queue, {
        siteId: site.id,
        workspaceId: site.workspaceId,
        companyId: site.companyId,
        type: "seed",
        payload,
      });
      return {
        type: action.type,
        ok: true,
        detail: `Re-seeding ${site.companyName ?? site.id} with ${payload.sourceUrl}.`,
      };
    }

    case "triggerJob": {
      const site = await findSite(db, a["site"] ?? "");
      if (!site) return { type: action.type, ok: false, detail: `Couldn't find site “${a["site"] ?? ""}”.` };
      const jobType = (a["jobType"] ?? "seed") as "seed" | "build" | "deploy-staging" | "promote" | "rollback";
      if (!["seed", "build", "deploy-staging", "promote", "rollback"].includes(jobType)) {
        return { type: action.type, ok: false, detail: `Unknown job type “${a["jobType"] ?? ""}”.` };
      }
      // Same guards the UI buttons enforce — the chat can't skip state checks,
      // and production mutations must be explicit.
      if ((jobType === "deploy-staging" || jobType === "build") && site.status !== "built" && site.status !== "deployed" && site.status !== "seeded") {
        return {
          type: action.type,
          ok: false,
          detail: `${site.companyName ?? site.id} isn't built yet (status=${site.status}). Run the seed first.`,
        };
      }
      if ((jobType === "promote" || jobType === "rollback") && site.status !== "deployed") {
        return {
          type: action.type,
          ok: false,
          detail: `${site.companyName ?? site.id} has no staging deploy (status=${site.status}) — nothing to ${jobType}. Publish staging first.`,
        };
      }
      const job = await enqueueJob(db, queue, {
        siteId: site.id,
        workspaceId: site.workspaceId,
        companyId: site.companyId,
        type: jobType,
        payload: site.status === "seeded" || jobType === "seed" ? JSON.parse(a["payload"] ?? "{}") : {},
      });
      void job;
      return { type: action.type, ok: true, detail: `${jobType} queued for ${site.companyName ?? site.slug ?? site.id}.` };
    }

    case "setStage": {
      const site = await findSite(db, a["site"] ?? "");
      if (!site) return { type: action.type, ok: false, detail: `Couldn't find site “${a["site"] ?? ""}”.` };
      const stage = a["stage"] as SiteStage;
      if (!["onboarding", "building", "in-review", "live"].includes(stage)) {
        return { type: action.type, ok: false, detail: `Stage must be onboarding|building|in-review|live.` };
      }
      await db.updateTable("sites").set({ stage }).where("id", "=", site.id).execute();
      return { type: action.type, ok: true, detail: `${site.companyName ?? site.id} moved to ${stage}.` };
    }

    case "addTodo": {
      if (!a["title"]) return { type: action.type, ok: false, detail: "Todo needs a title." };
      const site = a["site"] ? await findSite(db, a["site"]) : null;
      await db
        .insertInto("todos")
        .values({
          id: randomUUID(),
          siteId: site?.id ?? null,
          companyId: site?.companyId ?? null,
          title: a["title"],
          actionType: a["actionType"] ?? null,
          actionPayload: JSON.stringify(site ? { siteId: site.id } : {}),
          status: "open",
          assignee: actor,
          createdAt: now(),
          doneAt: null,
        })
        .execute();
      return { type: action.type, ok: true, detail: `Todo added: “${a["title"]}”.` };
    }

    case "completeTodo": {
      const like = `%${(a["title"] ?? a["id"] ?? "").toLowerCase()}%`;
      const todo = a["id"]
        ? await db.selectFrom("todos").selectAll().where("id", "=", a["id"]).executeTakeFirst()
        : await db
            .selectFrom("todos")
            .selectAll()
            .where(sql`lower(title)`, "like", like)
            .where("status", "=", "open")
            .executeTakeFirst();
      if (!todo) return { type: action.type, ok: false, detail: "Couldn't find that todo." };
      await db
        .updateTable("todos")
        .set({ status: "done", doneAt: now() })
        .where("id", "=", todo.id)
        .execute();
      return { type: action.type, ok: true, detail: `Done: “${todo.title}”.` };
    }

    default:
      return { type: "none", ok: true, detail: "" };
  }
}
