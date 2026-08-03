/**
 * Storage factory. S3 when STORAGE_BUCKET is configured (production, or MinIO
 * via STORAGE_ENDPOINT for local dev); otherwise local disk so dev and tests
 * run the same code path with zero infra.
 *
 * Env vars:
 *   STORAGE_BUCKET    — S3 bucket; presence selects the S3 backend
 *   STORAGE_ENDPOINT  — optional custom endpoint (MinIO: http://localhost:9000)
 *   STORAGE_KEY       — access key (omit to use the AWS default credential chain)
 *   STORAGE_SECRET    — secret key
 *   STORAGE_REGION    — optional, defaults to us-east-1
 *   MILO_STORAGE_DIR  — local backend root override
 *   CAPTURE_CACHE_DIR — deprecated alias for MILO_STORAGE_DIR
 */
import os from "node:os";
import path from "node:path";
import type { StorageAdapter } from "./adapter.ts";
import { LocalFsAdapter } from "./local.ts";
import { S3Adapter } from "./s3.ts";

export type { StorageAdapter } from "./adapter.ts";
export { LocalFsAdapter } from "./local.ts";
export { S3Adapter } from "./s3.ts";
export type { S3AdapterOpts } from "./s3.ts";
export {
  emptyLibrary, loadLibrary, saveLibrary, addAsset, getAsset,
  updateAssetTags, archiveAsset, recordUsage, findByHash, findBySourceRef,
} from "./asset-library.ts";
export type { Asset, AssetTags, AssetUsage, AssetLibrary } from "./asset-library.ts";
export { ingestAsset, ingestFromUrl, sniffImage } from "./asset-ingest.ts";
export type { IngestOpts, IngestResult, IngestFromUrlOpts } from "./asset-ingest.ts";
export { findAsset } from "./asset-find.ts";
export type { FindQuery } from "./asset-find.ts";

export function getStorage(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  if (env.STORAGE_BUCKET) {
    return new S3Adapter({
      bucket: env.STORAGE_BUCKET,
      region: env.STORAGE_REGION,
      endpoint: env.STORAGE_ENDPOINT,
      accessKeyId: env.STORAGE_KEY,
      secretAccessKey: env.STORAGE_SECRET,
    });
  }
  const root = env.MILO_STORAGE_DIR ?? env.CAPTURE_CACHE_DIR ?? path.join(os.homedir(), ".milo");
  return new LocalFsAdapter(root);
}

/** Stable per-site slug derived from a URL: hostname, lowercase, no leading www., dots→dashes. */
export function slugFromUrl(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return host.replace(/\./g, "-");
}

/** Human-readable URI prefix for a backend, e.g. file:///Users/x/.milo or s3://bucket. */
export function describeStorage(storage: StorageAdapter): string {
  if (storage instanceof LocalFsAdapter) return `file://${storage.root}`;
  if (storage instanceof S3Adapter) return `s3://${storage.bucket}`;
  return "custom";
}
