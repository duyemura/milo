/**
 * Storage seam: one code path for engine state (capture cache today, edit
 * state later) backed by local disk in dev/tests or S3/MinIO in production.
 *
 * Keys are `/`-separated relative paths (e.g. `capture/<urlSlug>.json`) —
 * they map to object keys in S3 and to paths under the root dir on disk.
 */
export interface StorageAdapter {
  /** Read a key. Returns null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Write a key, creating it or overwriting it. */
  put(key: string, data: Buffer): Promise<void>;
  /** True when the key exists. */
  exists(key: string): Promise<boolean>;
  /** Delete a key. Deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;
}
