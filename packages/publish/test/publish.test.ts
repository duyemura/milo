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

describe("publishProduction", () => {
  let s3: FakeS3Adapter;
  let kvs: FakeKvsAdapter;

  beforeEach(async () => {
    s3 = new FakeS3Adapter();
    kvs = new FakeKvsAdapter();
    // seed a staging publish first
    let counter = 0;
    const generateId = () => `v${++counter}`;
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });
  });

  it("sets production pointer to match staging and updates KVS production entry", async () => {
    await publishProduction({ config, s3, kvs });

    const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
    expect(current?.production).toBe(current?.staging);

    const productionHost = `${config.slug}.${config.siteDomain}`;
    expect(kvs.entries.get(productionHost)).toBeTruthy();
  });

  it("exits early if production already matches staging", async () => {
    await publishProduction({ config, s3, kvs });
    await expect(
      publishProduction({ config, s3, kvs }),
    ).rejects.toThrow("Production is already up to date with staging");
  });

  it("throws if current.json does not exist yet", async () => {
    const freshS3 = new FakeS3Adapter();
    await expect(
      publishProduction({ config, s3: freshS3, kvs }),
    ).rejects.toThrow("No staging version found");
  });
});

describe("publishStatus", () => {
  it("returns the current staging and production info", async () => {
    const s3 = new FakeS3Adapter();
    const kvs = new FakeKvsAdapter();
    let counter = 0;
    const generateId = () => `v${++counter}`;
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });

    const status = await publishStatus({ config, s3 });
    expect(status?.slug).toBe(config.slug);
    expect(status?.stagingVersion).toBeTruthy();
    expect(status?.productionVersion).toBeUndefined();
    expect(status?.historyCount).toBe(1);
  });

  it("shows production version after promote", async () => {
    const s3 = new FakeS3Adapter();
    const kvs = new FakeKvsAdapter();
    let counter = 0;
    const generateId = () => `v${++counter}`;
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });
    await publishProduction({ config, s3, kvs });

    const status = await publishStatus({ config, s3 });
    expect(status?.productionVersion).toBeTruthy();
    expect(status?.inSync).toBe(true);
  });

  it("returns null if never published", async () => {
    const s3 = new FakeS3Adapter();
    const status = await publishStatus({ config, s3 });
    expect(status).toBeNull();
  });
});

describe("publishRollback", () => {
  let s3: FakeS3Adapter;
  let kvs: FakeKvsAdapter;

  beforeEach(async () => {
    s3 = new FakeS3Adapter();
    kvs = new FakeKvsAdapter();
    // publish three staging versions with distinct IDs
    let counter = 0;
    const generateId = () => `v${++counter}`;
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });
    await publishStaging({ config, distDir: "/tmp", s3, kvs, generateId });
  });

  it("in list mode (no versionId), returns available versions without changing anything", async () => {
    const result = await publishRollback({ config, env: "staging", s3, kvs });
    expect(result.kind).toBe("list");
    if (result.kind === "list") {
      expect(result.versions).toHaveLength(3);
    }
    // current.json must not have changed
    const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
    expect(current?.history).toHaveLength(3);
  });

  it("in rollback mode, sets the env pointer to the specified version and updates KVS", async () => {
    const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
    const targetVersion = current!.history[2]; // oldest

    await publishRollback({ config, env: "staging", versionId: targetVersion, s3, kvs });

    const after = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
    expect(after?.staging).toBe(targetVersion);

    const stagingHost = `${config.slug}-staging.${config.siteDomain}`;
    expect(kvs.entries.get(stagingHost)).toContain(targetVersion);
  });

  it("throws if versionId is not in history", async () => {
    await expect(
      publishRollback({ config, env: "staging", versionId: "nonexistent", s3, kvs }),
    ).rejects.toThrow("Version nonexistent not found");
  });

  it("throws if already on that version", async () => {
    const current = await s3.getJson<CurrentJson>(currentJsonKey(config.slug));
    await expect(
      publishRollback({ config, env: "staging", versionId: current!.staging, s3, kvs }),
    ).rejects.toThrow("Already on that version");
  });
});
