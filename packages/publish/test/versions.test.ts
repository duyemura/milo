import { describe, expect, it } from "vitest";
import {
  generateVersionId,
  CurrentJson,
  addStagingVersion,
  promoteToProduction,
  rollbackEnv,
  computePrune,
} from "../src/versions.ts";

describe("generateVersionId", () => {
  it("matches the colon-safe ISO timestamp format", () => {
    const id = generateVersionId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  });
  it("is sortable lexicographically (newer > older)", () => {
    const a = generateVersionId();
    const b = generateVersionId();
    expect(a.length).toBe(b.length);
  });
});

describe("CurrentJson schema", () => {
  it("parses a valid object", () => {
    const result = CurrentJson.safeParse({
      staging: "2026-07-21T11-00-00Z",
      production: "2026-07-20T09-00-00Z",
      history: ["2026-07-21T11-00-00Z", "2026-07-20T09-00-00Z"],
    });
    expect(result.success).toBe(true);
  });
  it("allows production to be undefined (not yet published)", () => {
    const result = CurrentJson.safeParse({
      staging: "2026-07-21T11-00-00Z",
      history: ["2026-07-21T11-00-00Z"],
    });
    expect(result.success).toBe(true);
  });
  it("rejects missing staging", () => {
    const result = CurrentJson.safeParse({ production: "x", history: [] });
    expect(result.success).toBe(false);
  });
});

describe("addStagingVersion", () => {
  it("creates a fresh CurrentJson on first publish (current = null)", () => {
    const result = addStagingVersion(null, "v1");
    expect(result.staging).toBe("v1");
    expect(result.production).toBeUndefined();
    expect(result.history).toEqual(["v1"]);
  });
  it("prepends to history and updates staging, leaves production unchanged", () => {
    const current = { staging: "v1", production: "v0", history: ["v1", "v0"] };
    const result = addStagingVersion(current, "v2");
    expect(result.staging).toBe("v2");
    expect(result.production).toBe("v0");
    expect(result.history).toEqual(["v2", "v1", "v0"]);
  });
});

describe("promoteToProduction", () => {
  it("sets production to current staging", () => {
    const current = { staging: "v2", production: "v1", history: ["v2", "v1"] };
    expect(promoteToProduction(current).production).toBe("v2");
  });
  it("leaves staging and history unchanged", () => {
    const current = { staging: "v2", production: "v1", history: ["v2", "v1"] };
    const result = promoteToProduction(current);
    expect(result.staging).toBe("v2");
    expect(result.history).toEqual(["v2", "v1"]);
  });
});

describe("rollbackEnv", () => {
  it("sets staging to the specified version", () => {
    const current = { staging: "v3", production: "v2", history: ["v3", "v2", "v1"] };
    expect(rollbackEnv(current, "staging", "v1").staging).toBe("v1");
  });
  it("sets production to the specified version", () => {
    const current = { staging: "v3", production: "v2", history: ["v3", "v2", "v1"] };
    expect(rollbackEnv(current, "production", "v1").production).toBe("v1");
  });
  it("leaves the other env pointer unchanged", () => {
    const current = { staging: "v3", production: "v2", history: ["v3", "v2", "v1"] };
    expect(rollbackEnv(current, "staging", "v1").production).toBe("v2");
  });
});

describe("computePrune", () => {
  const makeHistory = (n: number) =>
    Array.from({ length: n }, (_, i) => `v${n - i}`);

  it("keeps all versions when under the limit", () => {
    const current = { staging: "v5", production: "v4", history: makeHistory(5) };
    const { toDelete, updatedHistory } = computePrune(current, [], 10);
    expect(toDelete).toEqual([]);
    expect(updatedHistory).toHaveLength(5);
  });

  it("deletes oldest versions beyond the limit", () => {
    const current = { staging: "v12", production: "v11", history: makeHistory(12) };
    const { toDelete, updatedHistory } = computePrune(current, [], 10);
    expect(toDelete).toContain("v1");
    expect(toDelete).toContain("v2");
    expect(updatedHistory).toHaveLength(10);
  });

  it("never deletes the active staging or production version even if beyond the limit", () => {
    const history = ["v12", "v11", "v10", "v9", "v8", "v7", "v6", "v5", "v4", "v3", "v2", "v1"];
    const current = { staging: "v12", production: "v1", history };
    const { toDelete } = computePrune(current, [], 10);
    expect(toDelete).not.toContain("v1");
    expect(toDelete).not.toContain("v12");
  });

  it("deletes orphaned S3 prefixes not in history", () => {
    const current = { staging: "v2", production: "v1", history: ["v2", "v1"] };
    const s3VersionIds = ["v2", "v1", "orphan-incomplete"];
    const { toDelete } = computePrune(current, s3VersionIds, 10);
    expect(toDelete).toContain("orphan-incomplete");
  });
});
