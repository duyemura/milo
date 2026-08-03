/**
 * Deploy cleanup: once publishStaging has pushed the assembled site to
 * S3/CloudFront, the on-disk dist dir is ephemeral — remove it immediately.
 * A failed publish keeps the dir (retry/debug) and still throws.
 *
 * @milo/publish is mocked at the module boundary — deploy() must never touch
 * the network in tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@milo/publish", () => ({
  publishStaging: vi.fn(async () => {}),
  createRealS3Adapter: vi.fn(() => ({})),
  createRealKvsAdapter: vi.fn(() => ({})),
}));

import { deploy } from "../src/deploy.ts";
import { publishStaging } from "@milo/publish";

function makeDistDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milo-deploy-test-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html>assembled</html>");
  return dir;
}

describe("deploy cleanup", () => {
  const savedArn = process.env.CLOUDFRONT_KVS_ARN;

  beforeEach(() => {
    process.env.CLOUDFRONT_KVS_ARN = "arn:aws:cloudfront::123:key-value-store/test";
    vi.mocked(publishStaging).mockClear();
  });
  afterEach(() => {
    if (savedArn === undefined) delete process.env.CLOUDFRONT_KVS_ARN;
    else process.env.CLOUDFRONT_KVS_ARN = savedArn;
  });

  it("removes the dist dir only after the publish completes", async () => {
    const distDir = makeDistDir();
    let existedDuringPublish: boolean | undefined;
    vi.mocked(publishStaging).mockImplementationOnce(async () => {
      existedDuringPublish = fs.existsSync(path.join(distDir, "index.html"));
    });

    await deploy({ distDir, slug: "test-gym" });

    expect(existedDuringPublish).toBe(true); // not deleted before/during push
    expect(fs.existsSync(distDir)).toBe(false); // gone immediately after
  });

  it("keeps the dist dir when the publish fails", async () => {
    const distDir = makeDistDir();
    vi.mocked(publishStaging).mockRejectedValueOnce(new Error("s3 boom"));

    await expect(deploy({ distDir, slug: "test-gym" })).rejects.toThrow("s3 boom");
    expect(fs.existsSync(path.join(distDir, "index.html"))).toBe(true);
  });

  it("still requires CLOUDFRONT_KVS_ARN", async () => {
    delete process.env.CLOUDFRONT_KVS_ARN;
    await expect(deploy({ distDir: makeDistDir(), slug: "test-gym" })).rejects.toThrow(/CLOUDFRONT_KVS_ARN/);
  });
});
