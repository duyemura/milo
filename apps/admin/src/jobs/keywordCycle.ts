import { randomUUID } from "node:crypto";
import path from "node:path";
import * as fs from "node:fs";
import { runKeywordCycle, discover, type SuggestFn, type PageBrief } from "@milo/keyword-brain";
import type { ChatFn } from "@milo/llm";
import type { AdminDb } from "../db/index.ts";
import type { AdminConfig } from "../config.ts";
import type { JobRow, SiteRow } from "../db/types.ts";
import { appendLog } from "./dispatch.ts";

export interface BrainDeps {
  chat: ChatFn | null;
  suggest?: SuggestFn;
}

/** Write the builder's JSON drop (regenerated from current brief statuses). */
export async function emitBriefDrop(db: AdminDb, dataDir: string, siteId: string): Promise<string> {
  const rows = await db
    .selectFrom("page_briefs")
    .selectAll()
    .where("siteId", "=", siteId)
    .orderBy("createdAt", "desc")
    .execute();
  const dir = path.join(dataDir, "briefs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${siteId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        siteId,
        updatedAt: new Date().toISOString(),
        briefs: rows.map((r) => ({ ...JSON.parse(r.payload), status: r.status })),
      },
      null,
      2,
    ),
  );
  return file;
}

/** Context assembly: seed payload carries name/city/state for template seeds; job payload may override. */
async function gymFacts(db: AdminDb, site: SiteRow, jobPayload: Record<string, string>) {
  const lastSeed = await db
    .selectFrom("jobs")
    .selectAll()
    .where("siteId", "=", site.id)
    .where("type", "=", "seed")
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
  const seed = lastSeed ? (JSON.parse(lastSeed.payload) as Record<string, string>) : {};
  return {
    name: jobPayload["name"] ?? seed["name"],
    city: jobPayload["city"] ?? seed["city"],
    state: jobPayload["state"] ?? seed["state"],
  };
}

export async function runKeywordCycleJob(opts: {
  db: AdminDb;
  config: AdminConfig;
  job: JobRow;
  site: SiteRow;
  brain: BrainDeps;
}): Promise<string> {
  const { db, config, job, site, brain } = opts;
  const log = (line: string) => appendLog(db, job.id, line);
  if (!brain.chat) {
    throw new Error("Keyword cycle needs an LLM (OPENROUTER_API_KEY) — rule-free research is not real research.");
  }

  const payload = JSON.parse(job.payload) as Record<string, string>;
  const facts = await gymFacts(db, site, payload);
  await log(`gym facts: name=${facts.name ?? "?"} city=${facts.city ?? "?"} state=${facts.state ?? "?"}`);
  if (!facts.name || !facts.city || !facts.state) {
    throw new Error(
      "Keyword cycle needs the gym's name, city, and state — pass them in the job payload (seed payloads carry them for template seeds).",
    );
  }

  const company = await db.selectFrom("companies").selectAll().where("id", "=", site.companyId).executeTakeFirstOrThrow();
  const model = config.chatModel;

  const { context, neighborhoods } = await discover({
    input: {
      siteId: site.id,
      companyId: company.id,
      companyName: facts.name,
      sourceUrl: site.sourceUrl,
      city: facts.city,
      state: facts.state,
    },
    chat: brain.chat,
    model,
  });
  await log(`discover: ${context.activities.length} activities, ${neighborhoods.length} neighborhoods`);

  const result = await runKeywordCycle({
    context,
    neighborhoods,
    chat: brain.chat,
    model,
    suggest: brain.suggest,
    onLog: (line) => void log(line),
  });

  const now = new Date().toISOString();
  for (const b of result.briefs as PageBrief[]) {
    await db
      .insertInto("page_briefs")
      .values({
        id: randomUUID(),
        workspaceId: site.workspaceId,
        companyId: site.companyId,
        siteId: site.id,
        payload: JSON.stringify(b),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  }
  const drop = await emitBriefDrop(db, config.dataDir, site.id);
  await log(`wrote ${result.briefs.length} brief(s) → page_briefs + ${drop}`);
  return result.digest;
}
