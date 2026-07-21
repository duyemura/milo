export interface S3Adapter {
  /** Upload all files under distDir to the given S3 prefix. */
  uploadDirectory(prefix: string, distDir: string): Promise<void>;
  /** Write a JSON object to a single S3 key. */
  putJson(key: string, value: unknown): Promise<void>;
  /** Read a JSON object from a single S3 key. Returns null if key does not exist. */
  getJson<T>(key: string): Promise<T | null>;
  /** List version IDs (timestamps) present under gyms/{gymSlug}/versions/ in S3. */
  listVersionIds(gymSlug: string): Promise<string[]>;
  /** Delete all S3 objects under gyms/{gymSlug}/versions/{versionId}/. */
  deleteVersionPrefix(gymSlug: string, versionId: string): Promise<void>;
}

export function currentJsonKey(gymSlug: string): string {
  return `gyms/${gymSlug}/current.json`;
}

export function versionPrefix(gymSlug: string, versionId: string): string {
  return `gyms/${gymSlug}/versions/${versionId}/`;
}

export function completeMarkerKey(gymSlug: string, versionId: string): string {
  return `${versionPrefix(gymSlug, versionId)}_complete`;
}

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain",
  ".xml":  "application/xml",
};

function mimeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? dir, e.name));
}

export function createRealS3Adapter(opts: {
  bucket: string;
  region: string;
  awsProfile: string;
}): S3Adapter {
  const client = new S3Client({
    region: opts.region,
    credentials: fromIni({ profile: opts.awsProfile }),
  });

  return {
    async uploadDirectory(prefix: string, distDir: string): Promise<void> {
      const files = await walkDir(distDir);
      await Promise.all(
        files.map(async (filePath) => {
          const relative = path.relative(distDir, filePath);
          const key = `${prefix}${relative.replace(/\\/g, "/")}`;
          const body = await readFile(filePath);
          await client.send(
            new PutObjectCommand({
              Bucket: opts.bucket,
              Key: key,
              Body: body,
              ContentType: mimeFor(filePath),
            }),
          );
        }),
      );
    },

    async putJson(key: string, value: unknown): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: JSON.stringify(value, null, 2),
          ContentType: "application/json",
        }),
      );
    },

    async getJson<T>(key: string): Promise<T | null> {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: opts.bucket, Key: key }),
        );
        const body = await result.Body?.transformToString();
        return body ? (JSON.parse(body) as T) : null;
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },

    async listVersionIds(gymSlug: string): Promise<string[]> {
      const prefix = `gyms/${gymSlug}/versions/`;
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: opts.bucket,
          Prefix: prefix,
          Delimiter: "/",
        }),
      );
      return (result.CommonPrefixes ?? [])
        .map((p) => p.Prefix?.slice(prefix.length).replace(/\/$/, "") ?? "")
        .filter(Boolean);
    },

    async deleteVersionPrefix(gymSlug: string, versionId: string): Promise<void> {
      const prefix = versionPrefix(gymSlug, versionId);
      const list = await client.send(
        new ListObjectsV2Command({ Bucket: opts.bucket, Prefix: prefix }),
      );
      const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objects.length === 0) return;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: opts.bucket,
          Delete: { Objects: objects },
        }),
      );
    },
  };
}
