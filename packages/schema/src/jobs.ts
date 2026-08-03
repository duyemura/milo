import { z } from "zod";

export const LearnJob = z.object({
  type: z.literal("learn"),
  url: z.string().url(),
  verbose: z.boolean().default(false),
});

export const CloneJob = z.object({
  type: z.literal("clone"),
  url: z.string().url(),
  templateId: z.string().optional(),
  refreshDocs: z.boolean().default(false),
  docsSlug: z.string().optional(),
  includeUgc: z.boolean().default(false),
  ugcLimit: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  deploy: z.boolean().default(false),          // publish to staging after a successful build
});

export const DeployJob = z.object({
  type: z.literal("deploy"),
  slug: z.string(),
  env: z.enum(["staging", "production"]),
  versionId: z.string().optional(),
});

export const MiloJob = z.discriminatedUnion("type", [LearnJob, CloneJob, DeployJob]);
export type MiloJob = z.infer<typeof MiloJob>;
export type LearnJob = z.infer<typeof LearnJob>;
export type CloneJob = z.infer<typeof CloneJob>;
export type DeployJob = z.infer<typeof DeployJob>;
