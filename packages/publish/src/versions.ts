import { z } from "zod";

export const CurrentJson = z.object({
  staging: z.string(),
  production: z.string().optional(),
  history: z.array(z.string()),
});
export type CurrentJson = z.infer<typeof CurrentJson>;

export function generateVersionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

export function addStagingVersion(
  current: CurrentJson | null,
  versionId: string,
): CurrentJson {
  if (!current) {
    return { staging: versionId, history: [versionId] };
  }
  return {
    staging: versionId,
    production: current.production,
    history: [versionId, ...current.history],
  };
}

export function promoteToProduction(current: CurrentJson): CurrentJson {
  return { ...current, production: current.staging };
}

export function rollbackEnv(
  current: CurrentJson,
  env: "staging" | "production",
  versionId: string,
): CurrentJson {
  return { ...current, [env]: versionId };
}

export function computePrune(
  current: CurrentJson,
  s3VersionIds: string[],
  maxVersions = 10,
): { toDelete: string[]; updatedHistory: string[] } {
  const protected_ = new Set(
    [current.staging, current.production].filter((v): v is string => v !== undefined),
  );
  const toDelete: string[] = [];
  const updatedHistory: string[] = [];

  for (let i = 0; i < current.history.length; i++) {
    const vid = current.history[i];
    if (protected_.has(vid) || i < maxVersions) {
      updatedHistory.push(vid);
    } else {
      toDelete.push(vid);
    }
  }

  const historySet = new Set(updatedHistory);
  for (const vid of s3VersionIds) {
    if (!historySet.has(vid) && !protected_.has(vid)) {
      toDelete.push(vid);
    }
  }

  return { toDelete: [...new Set(toDelete)], updatedHistory };
}
