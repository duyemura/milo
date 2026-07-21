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
  rollbackEnv,
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

export async function publishStatus(opts: {
  config: PublishConfig;
  s3: S3Adapter;
}): Promise<PublishStatusResult | null> {
  const { config, s3 } = opts;

  const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
  if (!current) return null;

  const stagingUrl = `https://${config.slug}-staging.${config.siteDomain}`;
  const productionUrl = `https://${config.slug}.${config.siteDomain}`;
  const result: PublishStatusResult = {
    slug: config.slug,
    stagingUrl,
    productionUrl,
    stagingVersion: current.staging,
    productionVersion: current.production,
    historyCount: current.history.length,
    inSync: current.production === current.staging,
  };

  console.log(`Gym:        ${config.slug}`);
  console.log(`Staging:    ${stagingUrl}`);
  console.log(`            version: ${current.staging}`);
  if (current.production) {
    console.log(`Production: ${productionUrl}`);
    console.log(`            version: ${current.production}`);
    if (result.inSync) console.log(`            (staging and production in sync)`);
  } else {
    console.log(`Production: not yet published`);
  }
  console.log(`History:    ${current.history.length} versions stored (10 max)`);

  return result;
}

export type RollbackResult =
  | { kind: "list"; versions: Array<{ versionId: string; isCurrent: boolean }> }
  | { kind: "rolled-back"; env: "staging" | "production"; versionId: string };

export async function publishRollback(opts: {
  config: PublishConfig;
  env: "staging" | "production";
  versionId?: string;
  s3: S3Adapter;
  kvs: KvsAdapter;
}): Promise<RollbackResult> {
  const { config, env, versionId, s3, kvs } = opts;

  const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
  if (!current) throw new Error("No publish history found. Run `milo publish staging` first.");

  const currentVersion = current[env];

  if (!versionId) {
    const versions = current.history.map((v) => ({ versionId: v, isCurrent: v === currentVersion }));
    console.log(`Available versions for ${env}:`);
    for (const v of versions) {
      console.log(`  ${v.isCurrent ? "*" : " "} ${v.versionId}${v.isCurrent ? "  (current)" : ""}`);
    }
    console.log(`Re-run with --version <id> to roll back.`);
    return { kind: "list", versions };
  }

  if (!current.history.includes(versionId)) {
    throw new Error(`Version ${versionId} not found in history.`);
  }

  if (currentVersion === versionId) {
    throw new Error(`Already on that version (${versionId}).`);
  }

  const updated = rollbackEnv(current, env, versionId);
  await s3.putJson(currentJsonKey(config.slug), updated);

  const host =
    env === "staging"
      ? `${config.slug}-staging.${config.siteDomain}`
      : `${config.slug}.${config.siteDomain}`;
  await kvs.put(host, versionPrefix(config.slug, versionId).replace(/\/$/, ""));

  console.log(`✓ Rolled back ${env} to ${versionId}`);
  return { kind: "rolled-back", env, versionId };
}
