/**
 * Capture cache on top of the StorageAdapter seam. Stores each page's
 * capture.json keyed by URL slug so builds skip re-running Playwright when
 * the source site hasn't changed. Local fs in dev, S3/MinIO in prod — the
 * caller never knows which.
 *
 * fs calls are sync to match orchestrate.ts's existing idiom; only the
 * storage hop is async.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StorageAdapter } from "@milo/storage";

/**
 * Cache key for a page URL: `capture/<slug>-<hash12>.json`.
 * The slug is human-readable (capped at 60 chars); the 12-char hash of the
 * full normalized URL prevents collisions between URLs that share a long
 * prefix or differ only in case.
 */
export function captureCacheKey(url: string): string {
  const normalized = url.toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const slug = normalized.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `capture/${slug}-${hash}.json`;
}

/**
 * Restore capture.json from the cache into captureDir. Returns true on a hit.
 * A capture.json already in the build dir always wins (never overwritten).
 */
export async function restoreCapture(
  storage: StorageAdapter,
  url: string,
  captureDir: string,
): Promise<boolean> {
  const dest = path.join(captureDir, "capture.json");
  if (fs.existsSync(dest)) return false;
  const cached = await storage.get(captureCacheKey(url));
  if (!cached) return false;
  fs.mkdirSync(captureDir, { recursive: true });
  fs.writeFileSync(dest, cached);
  return true;
}

/** Persist a freshly-captured capture.json to the cache. No-op when the file is missing. */
export async function persistCapture(
  storage: StorageAdapter,
  url: string,
  captureDir: string,
): Promise<void> {
  const src = path.join(captureDir, "capture.json");
  if (!fs.existsSync(src)) return;
  await storage.put(captureCacheKey(url), fs.readFileSync(src));
}
