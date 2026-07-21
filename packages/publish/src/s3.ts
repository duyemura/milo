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
