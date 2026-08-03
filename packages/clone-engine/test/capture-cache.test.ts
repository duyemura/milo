/**
 * Capture cache: the capture.json read/write seam used by buildOnePage,
 * backed by the StorageAdapter so dev (local fs) and prod (S3/MinIO) share
 * one code path. Tested against a real LocalFsAdapter in a temp dir.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFsAdapter } from "../src/storage/local.ts";
import { captureCacheKey, restoreCapture, persistCapture } from "../src/storage/capture-cache.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "milo-capture-cache-test-"));
}

describe("captureCacheKey", () => {
  it("slugs the URL under the capture/ prefix", () => {
    expect(captureCacheKey("https://speakeasyofstrength.com/about/")).toBe(
      "capture/https-speakeasyofstrength-com-about.json",
    );
  });

  it("caps the slug at 80 chars", () => {
    const key = captureCacheKey(`https://example.com/${"a".repeat(200)}`);
    const slug = key.slice("capture/".length, -".json".length);
    expect(slug.length).toBeLessThanOrEqual(80);
  });
});

describe("restoreCapture", () => {
  it("writes the cached capture.json into the capture dir and reports a hit", async () => {
    const storage = new LocalFsAdapter(tmp());
    const data = Buffer.from('{"url":"https://x.com/"}');
    await storage.put(captureCacheKey("https://x.com/"), data);

    const dir = path.join(tmp(), "cap-home");
    const hit = await restoreCapture(storage, "https://x.com/", dir);

    expect(hit).toBe(true);
    expect(fs.readFileSync(path.join(dir, "capture.json"))).toEqual(data);
  });

  it("reports a miss without creating the capture dir", async () => {
    const storage = new LocalFsAdapter(tmp());
    const dir = path.join(tmp(), "cap-home");

    const hit = await restoreCapture(storage, "https://never-captured.com/", dir);

    expect(hit).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("does not overwrite an existing capture.json (build dir wins)", async () => {
    const storage = new LocalFsAdapter(tmp());
    await storage.put(captureCacheKey("https://x.com/"), Buffer.from("cached"));

    const dir = tmp();
    fs.writeFileSync(path.join(dir, "capture.json"), "fresh");

    const hit = await restoreCapture(storage, "https://x.com/", dir);

    expect(hit).toBe(false);
    expect(fs.readFileSync(path.join(dir, "capture.json"), "utf8")).toBe("fresh");
  });
});

describe("persistCapture", () => {
  it("stores the capture dir's capture.json under the URL key", async () => {
    const storage = new LocalFsAdapter(tmp());
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "capture.json"), '{"captured":true}');

    await persistCapture(storage, "https://x.com/page", dir);

    const cached = await storage.get(captureCacheKey("https://x.com/page"));
    expect(cached?.toString()).toBe('{"captured":true}');
  });

  it("is a no-op when the capture produced no capture.json", async () => {
    const storage = new LocalFsAdapter(tmp());
    await persistCapture(storage, "https://x.com/", tmp());
    expect(await storage.exists(captureCacheKey("https://x.com/"))).toBe(false);
  });
});
