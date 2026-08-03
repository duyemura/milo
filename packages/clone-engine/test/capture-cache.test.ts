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
  it("slugs the URL under the capture/ prefix with a hash suffix", () => {
    const key = captureCacheKey("https://speakeasyofstrength.com/about/");
    expect(key).toMatch(/^capture\/https-speakeasyofstrength-com-about-[0-9a-f]{12}\.json$/);
  });

  it("is stable — same URL always produces the same key", () => {
    const url = "https://example.com/programs/";
    expect(captureCacheKey(url)).toBe(captureCacheKey(url));
  });

  it("is case-insensitive — /About and /about map to the same key", () => {
    expect(captureCacheKey("https://x.com/About")).toBe(captureCacheKey("https://x.com/about"));
  });

  it("keeps distinct URLs distinct even when the slug prefix is identical", () => {
    const base = "https://example.com/" + "a".repeat(100);
    expect(captureCacheKey(base + "/page-a")).not.toBe(captureCacheKey(base + "/page-b"));
  });

  it("caps the readable slug portion at 60 chars (hash appended after)", () => {
    const key = captureCacheKey(`https://example.com/${"a".repeat(200)}`);
    // key format: capture/<slug>-<12hexchars>.json
    const inner = key.slice("capture/".length, -".json".length);
    const slugPart = inner.slice(0, inner.lastIndexOf("-"));
    expect(slugPart.length).toBeLessThanOrEqual(60);
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
