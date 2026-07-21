import { existsSync } from "node:fs";
import type { S3Adapter } from "./s3.ts";
import { currentJsonKey, completeMarkerKey, versionPrefix } from "./s3.ts";
import type { KvsAdapter } from "./cloudfront.ts";
import type { PublishConfig } from "./config.ts";
import {
  type CurrentJson,
  generateVersionId,
  addStagingVersion,
  computePrune,
  promoteToProduction,
} from "./versions.ts";

export async function publishStaging(opts: {
  config: PublishConfig;
  distDir: string;
  s3: S3Adapter;
  kvs: KvsAdapter;
  /** Override version ID generation (useful in tests to ensure uniqueness). */
  generateId?: () => string;
}): Promise<void> {
  const { config, distDir, s3, kvs, generateId = generateVersionId } = opts;

  if (!existsSync(distDir)) {
    throw new Error(
      `dist/ not found at ${distDir}. Run the renderer build first (pnpm --filter renderer build).`,
    );
  }

  const versionId = generateId();
  const prefix = versionPrefix(config.slug, versionId);

  await s3.uploadDirectory(prefix, distDir);
  await s3.putJson(completeMarkerKey(config.slug, versionId), { ok: true });

  const existing = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
  const updated = addStagingVersion(existing, versionId);
  await s3.putJson(currentJsonKey(config.slug), updated);

  const stagingHost = `${config.slug}-staging.${config.siteDomain}`;
  await kvs.put(stagingHost, prefix.replace(/\/$/, ""));

  // Prune old versions
  const s3VersionIds = await s3.listVersionIds(config.slug);
  const { toDelete, updatedHistory } = computePrune(updated, s3VersionIds);
  if (toDelete.length > 0) {
    await Promise.all(toDelete.map((vid) => s3.deleteVersionPrefix(config.slug, vid)));
    await s3.putJson(currentJsonKey(config.slug), { ...updated, history: updatedHistory });
  }

  const stagingUrl = `https://${stagingHost}`;
  console.log(`Staging live: ${stagingUrl}`);
}

export async function publishProduction(opts: {
  config: PublishConfig;
  s3: S3Adapter;
  kvs: KvsAdapter;
}): Promise<void> {
  const { config, s3, kvs } = opts;

  const existing = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
  if (!existing?.staging) {
    throw new Error("No staging version found. Run `milo publish staging` first.");
  }

  if (existing.production === existing.staging) {
    throw new Error("Production is already up to date with staging.");
  }

  const updated = promoteToProduction(existing);
  await s3.putJson(currentJsonKey(config.slug), updated);

  const productionHost = `${config.slug}.${config.siteDomain}`;
  await kvs.put(productionHost, versionPrefix(config.slug, existing.staging).replace(/\/$/, ""));

  console.log(`✓ Production live: https://${productionHost}`);
}

export interface PublishStatusResult {
  slug: string;
  stagingUrl: string;
  productionUrl: string;
  stagingVersion: string;
  productionVersion: string | undefined;
  historyCount: number;
  inSync: boolean;
}

export async function publishStatus(_opts: {
  config: PublishConfig;
  s3: S3Adapter;
}): Promise<PublishStatusResult | null> {
  throw new Error("publishStatus not yet implemented");
}

export type RollbackResult =
  | { kind: "list"; versions: Array<{ versionId: string; isCurrent: boolean }> }
  | { kind: "rolled-back"; env: "staging" | "production"; versionId: string };

export async function publishRollback(_opts: {
  config: PublishConfig;
  env: "staging" | "production";
  versionId?: string;
  s3: S3Adapter;
  kvs: KvsAdapter;
}): Promise<RollbackResult> {
  throw new Error("publishRollback not yet implemented");
}
