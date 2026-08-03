/**
 * Storage adapter seam: one code path for the capture cache (and future state)
 * backed by local disk in dev/tests or S3/MinIO in production.
 *
 * LocalFsAdapter is tested against real temp dirs. S3Adapter is tested against
 * an in-memory fake S3 client (injected via the `client` option) that mirrors
 * real S3 semantics — NoSuchKey on missing gets, 404 NotFound on missing heads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { StorageAdapter } from "../src/adapter.ts";
import { LocalFsAdapter } from "../src/local.ts";
import { S3Adapter } from "../src/s3.ts";
import { getStorage, slugFromUrl, describeStorage } from "../src/index.ts";

/** In-memory S3 client double with real command classes, so the adapter's
 *  command wiring (Bucket/Key/Body) is exercised for real. */
function makeFakeS3() {
  const store = new Map<string, Buffer>();
  const client = {
    async send(cmd: unknown): Promise<unknown> {
      if (cmd instanceof GetObjectCommand) {
        const body = store.get(cmd.input.Key!);
        if (!body) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      if (cmd instanceof PutObjectCommand) {
        store.set(cmd.input.Key!, Buffer.from(cmd.input.Body as Buffer));
        return {};
      }
      if (cmd instanceof HeadObjectCommand) {
        if (!store.has(cmd.input.Key!)) {
          throw Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        }
        return {};
      }
      if (cmd instanceof DeleteObjectCommand) {
        store.delete(cmd.input.Key!);
        return {};
      }
      throw new Error(`fake S3: unexpected command ${(cmd as object).constructor.name}`);
    },
  };
  return { client: client as unknown as S3Client, store };
}

/** Shared conformance suite — every StorageAdapter must satisfy these. */
function adapterConformance(name: string, make: () => StorageAdapter) {
  describe(name, () => {
    it("get returns null for a missing key", async () => {
      expect(await make().get("nope/missing.json")).toBeNull();
    });

    it("put then get round-trips the exact bytes", async () => {
      const a = make();
      const data = Buffer.from('{"hello":"world","n":42}');
      await a.put("capture/example-com.json", data);
      expect(await a.get("capture/example-com.json")).toEqual(data);
    });

    it("exists reflects presence, delete removes", async () => {
      const a = make();
      expect(await a.exists("k")).toBe(false);
      await a.put("k", Buffer.from("v"));
      expect(await a.exists("k")).toBe(true);
      await a.delete("k");
      expect(await a.exists("k")).toBe(false);
      expect(await a.get("k")).toBeNull();
    });

    it("delete of a missing key is a no-op", async () => {
      await expect(make().delete("never-existed")).resolves.toBeUndefined();
    });

    it("put overwrites an existing key", async () => {
      const a = make();
      await a.put("k", Buffer.from("old"));
      await a.put("k", Buffer.from("new"));
      expect((await a.get("k"))?.toString()).toBe("new");
    });
  });
}

adapterConformance("LocalFsAdapter", () => new LocalFsAdapter(tmpRoot()));
adapterConformance("S3Adapter", () => new S3Adapter({ bucket: "test-bucket", client: makeFakeS3().client }));

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "milo-storage-test-"));
}

describe("LocalFsAdapter specifics", () => {
  it("creates parent directories on put", async () => {
    const root = tmpRoot();
    const a = new LocalFsAdapter(root);
    await a.put("deep/nested/key.json", Buffer.from("x"));
    expect(fs.readFileSync(path.join(root, "deep/nested/key.json"), "utf8")).toBe("x");
  });

  it("rejects keys that escape the root", async () => {
    const a = new LocalFsAdapter(tmpRoot());
    await expect(a.put("../escape", Buffer.from("x"))).rejects.toThrow(/escape|outside/i);
    await expect(a.get("../../etc/passwd")).rejects.toThrow(/escape|outside/i);
  });
});

describe("S3Adapter specifics", () => {
  it("targets the configured bucket", async () => {
    const { client, store } = makeFakeS3();
    const a = new S3Adapter({ bucket: "my-bucket", client });
    await a.put("capture/x.json", Buffer.from("1"));
    expect(store.has("capture/x.json")).toBe(true);
  });

  it("rethrows non-missing errors from get", async () => {
    const boom = { async send(): Promise<never> { throw new Error("credentials exploded"); } };
    const a = new S3Adapter({ bucket: "b", client: boom as unknown as S3Client });
    await expect(a.get("k")).rejects.toThrow("credentials exploded");
  });
});

describe("getStorage factory", () => {
  const STORAGE_ENV = ["STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_KEY", "STORAGE_SECRET", "STORAGE_REGION", "MILO_STORAGE_DIR", "CAPTURE_CACHE_DIR"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(STORAGE_ENV.map((k) => [k, process.env[k]]));
    for (const k of STORAGE_ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of STORAGE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns an S3Adapter when STORAGE_BUCKET is set", () => {
    process.env.STORAGE_BUCKET = "prod-bucket";
    process.env.STORAGE_KEY = "k";
    process.env.STORAGE_SECRET = "s";
    expect(getStorage()).toBeInstanceOf(S3Adapter);
  });

  it("returns a LocalFsAdapter when STORAGE_BUCKET is unset", () => {
    expect(getStorage()).toBeInstanceOf(LocalFsAdapter);
  });

  it("defaults the local root to ~/.milo when no override is set", () => {
    const a = getStorage() as LocalFsAdapter;
    expect(a.root).toBe(path.join(os.homedir(), ".milo"));
  });

  it("roots the local adapter at CAPTURE_CACHE_DIR when set (backwards compat)", async () => {
    const root = tmpRoot();
    process.env.CAPTURE_CACHE_DIR = root;
    const a = getStorage();
    await a.put("probe", Buffer.from("v"));
    expect(fs.existsSync(path.join(root, "probe"))).toBe(true);
  });

  it("prefers MILO_STORAGE_DIR over CAPTURE_CACHE_DIR when both are set", () => {
    const milo = tmpRoot();
    const legacy = tmpRoot();
    process.env.MILO_STORAGE_DIR = milo;
    process.env.CAPTURE_CACHE_DIR = legacy;
    const a = getStorage() as LocalFsAdapter;
    expect(a.root).toBe(milo);
  });

  it("passes STORAGE_ENDPOINT through to the S3 client (MinIO)", () => {
    process.env.STORAGE_BUCKET = "b";
    process.env.STORAGE_ENDPOINT = "http://localhost:9000";
    process.env.STORAGE_KEY = "minioadmin";
    process.env.STORAGE_SECRET = "minioadmin";
    const a = getStorage() as S3Adapter;
    expect(a).toBeInstanceOf(S3Adapter);
    // forcePathStyle is required for MinIO; surface it for the assertion.
    expect(a.forcePathStyle).toBe(true);
  });
});

describe("slugFromUrl", () => {
  it("derives stable slugs from URLs", () => {
    expect(slugFromUrl("https://speakeasyofstrength.com")).toBe("speakeasyofstrength-com");
    expect(slugFromUrl("https://www.Example-Gym.co.uk/path?q=1")).toBe("example-gym-co-uk");
  });
});

describe("describeStorage", () => {
  it("describes local and s3 backends as URIs", () => {
    expect(describeStorage(new LocalFsAdapter("/tmp/milo-x"))).toBe("file:///tmp/milo-x");
    // No network: constructing S3Adapter without a client never sends a request.
    expect(describeStorage(new S3Adapter({ bucket: "my-bucket" }))).toBe("s3://my-bucket");
  });
});
