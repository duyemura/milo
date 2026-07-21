import { describe, expect, it, beforeEach } from "vitest";
import { publishStaging, publishProduction, publishStatus, publishRollback } from "../src/publish.ts";
import { FakeS3Adapter, FakeKvsAdapter } from "./fakes.ts";
import { currentJsonKey } from "../src/s3.ts";
import type { CurrentJson } from "../src/versions.ts";
import type { PublishConfig } from "../src/config.ts";

const config: PublishConfig = {
  slug: "iron-anchor-4s1a",
  bucket: "test-bucket",
  region: "us-east-1",
  kvsArn: "arn:aws:cloudfront::123:key-value-store/abc",
  siteDomain: "sites.pushpress.com",
  awsProfile: "unicorn",
  gymJsonPath: "/tmp/gym.json",
  publishJsonPath: "/tmp/publish.json",
};

/** Counter-based fake ID generator — guarantees unique IDs within a test. */
function makeIdGen(): () => string {
  let n = 0;
  return () => `2026-01-01T00-00-0${n++}Z`;
}

describe("publishStaging", () => {
  let s3: FakeS3Adapter;
  let kvs: FakeKvsAdapter;

  beforeEach(() => {
    s3 = new FakeS3Adapter();
    kvs = new FakeKvsAdapter();
  });

  it("uploads dist, writes _complete, updates current.json, sets KVS staging entry", async () => {
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId: makeIdGen() });

    // _complete marker must exist
    const keys = [...s3.store.keys()];
    const completeKeys = keys.filter((k) => k.endsWith("/_complete"));
    expect(completeKeys).toHaveLength(1);

    // current.json must exist and have staging set
    const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
    expect(current?.staging).toBeTruthy();
    expect(current?.history).toHaveLength(1);

    // KVS staging entry must be set
    const stagingHost = `${config.slug}-staging.${config.siteDomain}`;
    expect(kvs.entries.get(stagingHost)).toBeTruthy();
  });

  it("on second publish, prepends to history and updates staging pointer", async () => {
    const generateId = makeIdGen();
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });

    const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
    expect(current?.history).toHaveLength(2);
    expect(current?.history[0]).not.toBe(current?.history[1]);
  });

  it("throws if distDir does not exist", async () => {
    await expect(
      publishStaging({ config, distDir: "/nonexistent/dist", s3, kvs }),
    ).rejects.toThrow("Run the renderer build first");
  });
});
