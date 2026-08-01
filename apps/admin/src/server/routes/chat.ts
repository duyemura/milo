import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ChatFn } from "@milo/llm";
import type { AdminDb } from "../../db/index.ts";
import type { EngineQueue } from "../../jobs/dispatch.ts";
import { deriveSuggestions, listManualTodos } from "../../chat/todos.ts";
import { routeMessage, type ChatTurn } from "../../chat/router.ts";
import { executeAction } from "../../chat/actions.ts";
import { parse } from "./schemas.ts";

const chatBody = z.object({
  message: z.string().min(1),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .default([]),
});

const todoBody = z.object({
  title: z.string().min(1),
  siteId: z.string().optional(),
});

export interface ChatDeps {
  db: AdminDb;
  queue: EngineQueue;
  chat: ChatFn | null;
  chatModel: string;
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): void {
  const { db, queue, chat, chatModel } = deps;

  app.get("/api/v1/todos", async () => ({
    suggestions: await deriveSuggestions(db),
    todos: await listManualTodos(db),
  }));

  app.post("/api/v1/todos", async (req, reply) => {
    const body = parse(todoBody, req.body, reply);
    if (!body) return;
    const row = {
      id: randomUUID(),
      siteId: body.siteId ?? null,
      companyId: null,
      title: body.title,
      actionType: null,
      actionPayload: "{}",
      status: "open" as const,
      assignee: req.actor.email,
      createdAt: new Date().toISOString(),
      doneAt: null,
    };
    await db.insertInto("todos").values(row).execute();
    return reply.code(201).send({ todo: row });
  });

  app.patch("/api/v1/todos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: "done" | "dismissed" };
    if (!status) return reply.code(400).send({ error: "status must be done or dismissed." });
    const r = await db
      .updateTable("todos")
      .set({ status, doneAt: new Date().toISOString() })
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) return reply.code(404).send({ error: "Todo not found." });
    return { ok: true };
  });

  app.post("/api/v1/chat", async (req, reply) => {
    void reply;
    const body = parse(chatBody, req.body, reply);
    if (!body) return;

    const routed = await routeMessage({
      db,
      chat,
      model: chatModel,
      message: body.message,
      history: body.history as ChatTurn[],
    });

    const effects = [];
    for (const action of routed.actions) {
      if (action.type === "none") continue;
      effects.push(await executeAction(db, queue, req.actor.email, action));
    }
    return {
      reply: routed.reply,
      effects,
      usedLlm: chat !== null,
    };
  });
}
