/**
 * S3 StorageAdapter — production backend for the storage seam. MinIO-compatible:
 * set `endpoint` (e.g. http://localhost:9000) and the client switches to
 * path-style addressing, which MinIO requires.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { StorageAdapter } from "./adapter.ts";

export interface S3AdapterOpts {
  bucket: string;
  region?: string;
  /** Custom endpoint (MinIO). When set, path-style addressing is forced on. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Inject a preconfigured client (tests). When omitted, one is built from the opts above. */
  client?: S3Client;
}

/** True for the error shapes S3/MinIO produce when a key is absent. */
function isMissingKey(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err.name === "NoSuchKey" ||
    err.name === "NotFound" ||
    err.$metadata?.httpStatusCode === 404
  );
}

export class S3Adapter implements StorageAdapter {
  private readonly bucket: string;
  private readonly client: S3Client;
  /** Exposed for diagnostics/tests — true when talking to a path-style endpoint (MinIO). */
  readonly forcePathStyle: boolean;

  constructor(opts: S3AdapterOpts) {
    this.bucket = opts.bucket;
    this.forcePathStyle = Boolean(opts.endpoint);
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region ?? "us-east-1",
        endpoint: opts.endpoint,
        forcePathStyle: this.forcePathStyle,
        credentials: opts.accessKeyId
          ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey ?? "" }
          : undefined, // fall back to the default provider chain (env, ~/.aws, IAM role)
      });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      if (isMissingKey(e)) return null;
      throw e;
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      if (isMissingKey(e)) return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 delete is idempotent — deleting a missing key is already a no-op.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
