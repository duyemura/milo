import { z } from "zod";
import { sql } from "kysely";
import { llmJson, type ChatFn } from "@milo/llm";
import type { AdminDb } from "../db/index.ts";
import type { ChatAction } from "./actions.ts";

const IntentSchema = z.object({
  reply: z.string(),
  actions: z
    .array(
      z.object({
        type: z.enum([
          "createWorkspace",
          "createCompany",
          "createSite",
          "triggerJob",
          "setStage",
          "addTodo",
          "completeTodo",
          "none",
        ]),
        args: z.record(z.string()).default({}),
      }),
    )
    .default([]),
});

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RouterResult {
  reply: string;
  actions: ChatAction[];
}

async function stateSummary(db: AdminDb): Promise<string> {
  const [workspaces, companies, sites, activeJobs, failedJobs] = await Promise.all([
    db.selectFrom("workspaces").select(["id", "name"]).execute(),
    db
      .selectFrom("companies")
      .innerJoin("workspaces", "workspaces.id", "companies.workspaceId")
      .select(["companies.id", "companies.name", "workspaces.name as workspaceName"])
      .execute(),
    db
      .selectFrom("sites")
      .innerJoin("companies", "companies.id", "sites.companyId")
      .select(["sites.id", "sites.slug", "sites.status", "sites.stage", "sites.sourceUrl", "companies.name as companyName"])
      .where("sites.active", "=", 1)
      .execute(),
    db
      .selectFrom("jobs")
      .select(["type", "status"])
      .where("status", "in", ["waiting", "queued", "running"])
      .execute(),
    db
      .selectFrom("jobs")
      .select(["type"])
      .where("status", "=", "failed")
      .orderBy("createdAt", "desc")
      .limit(5)
      .execute(),
  ]);
  return [
    `WORKSPACES: ${workspaces.map((w) => `${w.name} (${w.id})`).join("; ") || "none"}`,
    `GYMS: ${companies.map((c) => `${c.name} [${c.workspaceName}] (${c.id})`).join("; ") || "none"}`,
    `SITES: ${sites.map((s) => `${s.companyName}: ${s.slug ?? s.sourceUrl} status=${s.status} stage=${s.stage} (siteId=${s.id})`).join("; ") || "none"}`,
    `ACTIVE JOBS: ${activeJobs.map((j) => `${j.type}:${j.status}`).join(", ") || "none"}`,
    `RECENT FAILURES: ${failedJobs.map((j) => j.type).join(", ") || "none"}`,
  ].join("\n");
}

const SYSTEM = `You are the Milo admin assistant. The admin's job: launch gym websites, watch builds,
deploy, move sites through the pipeline (onboarding → building → in-review → live), and track todos.

Respond with JSON: {"reply": string (concise, sentence case), "actions": [{type, args}]}.
Action vocabulary (execute at most what the user asked; empty list when nothing to do):
- createWorkspace {name} — register a client org
- createCompany {name, companyId, workspaceId?} — register a gym (PushPress company ID required)
- createSite {company, sourceUrl, name, city, state, templateId?} — build a template site for a gym
- triggerJob {site, jobType} — jobType ∈ seed | build | deploy-staging | promote | rollback; "site" may be id, slug, URL fragment, or gym name
- setStage {site, stage} — stage ∈ onboarding | building | in-review | live
- addTodo {title, site?} — track something for the team
- completeTodo {title?|id?}
- none {} — pure conversation/status answers
"launch <name>" usually means: triggerJob {site: name, jobType: "deploy-staging"} if the site is built,
or createSite/seed if it isn't built yet. Never invent IDs — reference the SITE/GYM listing provided.
`;

/** LLM intent router. Fake `chat` in tests; absent chat → rule fallback. */
export async function routeMessage(opts: {
  db: AdminDb;
  chat: ChatFn | null;
  model: string;
  message: string;
  history: ChatTurn[];
}): Promise<RouterResult> {
  const { db, chat, message, history } = opts;
  const summary = await stateSummary(db);

  if (!chat) return ruleFallback(db, message, summary);

  const intent = await llmJson(IntentSchema, {
    chat,
    model: opts.model,
    messages: [
      { role: "system", content: `${SYSTEM}\n\nCURRENT STATE:\n${summary}` },
      ...history.slice(-10).map((t) => ({ role: t.role, content: t.content }) as const),
      { role: "user", content: message },
    ],
  });
  return { reply: intent.reply, actions: intent.actions as ChatAction[] };
}

/** Deterministic fallback for dev without an LLM key + for tests. */
export async function ruleFallback(db: AdminDb, message: string, summary: string): Promise<RouterResult> {
  const m = message.trim();

  const launch = /^(?:launch|build|deploy)\s+(.+)$/i.exec(m);
  if (launch) {
    const q = launch[1].replace(/[.!]$/, "").trim();
    const site = await db
      .selectFrom("sites")
      .innerJoin("companies", "companies.id", "sites.companyId")
      .selectAll("sites")
      .select("companies.name as companyName")
      .where((eb) =>
        eb.or([
          eb("sites.id", "=", q),
          eb(sql`lower(sites.slug)`, "like", `%${q.toLowerCase()}%`),
          eb(sql`lower(sites.sourceUrl)`, "like", `%${q.toLowerCase()}%`),
          eb(sql`lower(companies.name)`, "like", `%${q.toLowerCase()}%`),
        ]),
      )
      .executeTakeFirst();
    if (site) {
      const jobType = site.status === "built" ? "deploy-staging" : "seed";
      return {
        reply: `Launching ${site.companyName} — queued ${jobType}. Watch the Builds page; I'll keep the card up to date.`,
        actions: [{ type: "triggerJob", args: { site: site.id, jobType } }],
      };
    }
    return { reply: `Couldn't find a site or gym matching “${q}”.`, actions: [] };
  }

  const todoAdd = /^(?:todo|add todo|note|remember)\s*:?\s+(.+)$/i.exec(m);
  if (todoAdd) {
    return {
      reply: "Tracked.",
      actions: [{ type: "addTodo", args: { title: todoAdd[1] } }],
    };
  }

  const done = /^(?:done|complete)\s+(.+)$/i.exec(m);
  if (done) {
    return { reply: "Marked done.", actions: [{ type: "completeTodo", args: { title: done[1] } }] };
  }

  if (/status|what'?s (running|happening)|summary/i.test(m)) {
    return { reply: `Here's the picture:\n${summary}`, actions: [] };
  }

  return {
    reply:
      "I can launch sites (“launch Torrance”), kick builds, set pipeline stages, and track todos — try “launch <site>” or “todo: call client”. (LLM routing is off in this environment, so I understand simple commands only.)",
    actions: [],
  };
}
