/**
 * All learn doc I/O goes through DocStore — one code path for local disk and
 * S3/MinIO. Two modes:
 *   --out mode:  LocalFsAdapter(outDir), prefix "" — docs land exactly in outDir
 *   storage mode: getStorage() (or injected), prefix "gyms/<slug>/docs"
 */
import { readFile } from "node:fs/promises";
import { getStorage, LocalFsAdapter, slugFromUrl, describeStorage, type StorageAdapter } from "@milo/storage";

export class DocStore {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly prefix: string,
  ) {}

  private key(rel: string): string {
    return this.prefix ? `${this.prefix}/${rel}` : rel;
  }

  /** URI of the docs root, e.g. file:///Users/x/.milo/gyms/slug/docs or s3://b/gyms/slug/docs. */
  uri(): string {
    const base = describeStorage(this.storage);
    return this.prefix ? `${base}/${this.prefix}` : base;
  }

  async putJson(rel: string, value: unknown): Promise<void> {
    await this.storage.put(this.key(rel), Buffer.from(JSON.stringify(value, null, 2), "utf8"));
  }

  async putText(rel: string, text: string): Promise<void> {
    await this.storage.put(this.key(rel), Buffer.from(text, "utf8"));
  }

  async putFile(rel: string, absPath: string): Promise<void> {
    await this.storage.put(this.key(rel), await readFile(absPath));
  }

  async getJson(rel: string): Promise<unknown | null> {
    const buf = await this.storage.get(this.key(rel));
    return buf ? JSON.parse(buf.toString("utf8")) : null;
  }
}

export function resolveDocStore(opts: {
  url: string;
  outDir?: string;
  storage?: StorageAdapter;
  slug?: string;
}): DocStore {
  if (opts.storage) {
    return new DocStore(opts.storage, `gyms/${opts.slug ?? slugFromUrl(opts.url)}/docs`);
  }
  if (opts.outDir) {
    return new DocStore(new LocalFsAdapter(opts.outDir), "");
  }
  return new DocStore(getStorage(), `gyms/${opts.slug ?? slugFromUrl(opts.url)}/docs`);
}
