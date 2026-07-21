import type { S3Adapter } from "../src/s3.ts";
import type { KvsAdapter } from "../src/cloudfront.ts";

export class FakeS3Adapter implements S3Adapter {
  store: Map<string, string> = new Map();

  async uploadDirectory(prefix: string, _distDir: string): Promise<void> {
    this.store.set(`${prefix}index.html`, "<html/>");
    this.store.set(`${prefix}_astro/main.js`, "console.log('ok')");
  }

  async putJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async listVersionIds(gymSlug: string): Promise<string[]> {
    const prefix = `gyms/${gymSlug}/versions/`;
    const ids = new Set<string>();
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const versionId = rest.split("/")[0];
        if (versionId) ids.add(versionId);
      }
    }
    return [...ids];
  }

  async deleteVersionPrefix(gymSlug: string, versionId: string): Promise<void> {
    const prefix = `gyms/${gymSlug}/versions/${versionId}/`;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

export class FakeKvsAdapter implements KvsAdapter {
  entries: Map<string, string> = new Map();

  async put(host: string, s3Prefix: string): Promise<void> {
    this.entries.set(host, s3Prefix);
  }
}
