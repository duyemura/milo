/**
 * Local filesystem StorageAdapter — the default when no S3 config is present
 * (local dev, tests). Keys map to paths under a root dir.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { StorageAdapter } from "./adapter.ts";

export class LocalFsAdapter implements StorageAdapter {
  private readonly resolvedRoot: string;

  constructor(root: string) {
    this.resolvedRoot = path.resolve(root);
  }

  /** Absolute root dir — used by describeStorage. */
  get root(): string {
    return this.resolvedRoot;
  }

  /** Resolve a key to an absolute path under the root, rejecting traversal. */
  private resolve(key: string): string {
    const abs = path.resolve(this.resolvedRoot, key);
    if (abs !== this.resolvedRoot && !abs.startsWith(this.resolvedRoot + path.sep)) {
      throw new Error(`storage key escapes the local root: "${key}"`);
    }
    return abs;
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    const abs = this.resolve(key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}
