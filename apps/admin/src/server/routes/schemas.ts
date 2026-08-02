import { z } from "zod";
import type { FastifyReply } from "fastify";

export const createWorkspaceBody = z.object({
  name: z.string().min(1),
  contact: z.string().optional(),
});

export const createCompanyBody = z.object({
  workspaceId: z.string().min(1),
  companyId: z.string().min(1),
  name: z.string().min(1),
});

export const createSiteBody = z.object({
  companyId: z.string().min(1),
  seedType: z.enum(["clone", "template"]),
  sourceUrl: z.string().url().optional(),
  name: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  templateId: z.string().optional(),
});

export const createJobBody = z.object({
  type: z.enum(["seed", "build", "deploy-staging", "promote", "rollback"]),
  payload: z.record(z.string()).optional(),
});

export const setStageBody = z.object({
  stage: z.enum(["onboarding", "building", "in-review", "live"]),
});

const idParam = z.object({ id: z.string().min(1) });

/** Zod-parse helper; replies 400 with the first issue (sentence case) and returns undefined. */
export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  reply: FastifyReply,
): T | undefined {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  void reply.code(400).send({ error: `${issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request."}` });
  return undefined;
}

export function parseId(value: unknown, reply: FastifyReply): string | undefined {
  return parse(idParam, value, reply)?.id;
}
