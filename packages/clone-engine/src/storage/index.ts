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
 *   CAPTURE_CACHE_DIR — local backend root override (backwards compat)
 */
import os from "node:os";
import path from "node:path";
import type { StorageAdapter } from "./adapter.ts";
import { LocalFsAdapter } from "./local.ts";
import { S3Adapter } from "./s3.ts";

export type { StorageAdapter } from "./adapter.ts";
export { LocalFsAdapter } from "./local.ts";
export { S3Adapter } from "./s3.ts";

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
  const root = env.CAPTURE_CACHE_DIR ?? path.join(os.tmpdir(), "milo-storage");
  return new LocalFsAdapter(root);
}
