import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyLibrary,
  loadLibrary,
  saveLibrary,
  addAsset,
  getAsset,
  updateAssetTags,
  archiveAsset,
  recordUsage,
  type Asset,
  type AssetLibrary,
  type AssetTags,
} from "../../src/assets/library.ts";

function pendingTags(): AssetTags {
  return { pending: true, hasPeople: false, subjects: [], mood: [], setting: "product", description: "", quality: "medium" };
}

function fixtureAsset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id, source: "upload", file: `library/${id}.webp`, mime: "image/webp",
    dimensions: { w: 1600, h: 900 }, aspectRatio: "16:9", bytes: 12345,
    tags: pendingTags(), usages: [], status: "active", createdAt: "2026-08-02T00:00:00.000Z", ...over,
  };
}

describe("emptyLibrary", () => {
  it("creates a v1 library for a businessId with no assets", () => {
    const lib = emptyLibrary("biz_123");
    expect(lib.version).toBe(1);
    expect(lib.businessId).toBe("biz_123");
    expect(lib.assets).toEqual({});
  });
});

describe("loadLibrary / saveLibrary", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns an empty library when library.json does not exist", () => {
    const lib = loadLibrary(dir, "biz_123");
    expect(lib.assets).toEqual({});
    expect(lib.businessId).toBe("biz_123");
    expect(fs.existsSync(path.join(dir, "library.json"))).toBe(false);
  });

  it("round-trips a saved library through disk", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    saveLibrary(dir, lib);
    expect(fs.existsSync(path.join(dir, "library.json"))).toBe(true);
    const reloaded = loadLibrary(dir, "biz_123");
    expect(reloaded).toEqual(lib);
  });

  it("saveLibrary writes trailing-newline pretty JSON", () => {
    saveLibrary(dir, emptyLibrary("biz_123"));
    const raw = fs.readFileSync(path.join(dir, "library.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  ");
  });

  it("loadLibrary uses the businessId already stored in the file", () => {
    saveLibrary(dir, emptyLibrary("biz_original"));
    const lib = loadLibrary(dir, "biz_fallback");
    expect(lib.businessId).toBe("biz_original");
  });
});

describe("addAsset / getAsset", () => {
  it("adds an asset keyed by id and returns a NEW library (immutability)", () => {
    const before = emptyLibrary("biz_123");
    const after = addAsset(before, fixtureAsset("ast_a"));
    expect(before.assets).toEqual({});
    expect(after.assets["ast_a"]?.id).toBe("ast_a");
    expect(getAsset(after, "ast_a")?.id).toBe("ast_a");
  });

  it("getAsset returns undefined for an unknown id", () => {
    expect(getAsset(emptyLibrary("biz_123"), "ast_missing")).toBeUndefined();
  });

  it("throws when adding a duplicate id", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    expect(() => addAsset(lib, fixtureAsset("ast_a"))).toThrow(/ast_a/);
  });
});

describe("updateAssetTags", () => {
  it("replaces the tags of an existing asset and clears pending", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const filled: AssetTags = { pending: false, hasPeople: false, subjects: ["barbell", "weight plate"], activity: "lifting", mood: ["focused", "energetic"], setting: "product", description: "A loaded barbell.", quality: "high" };
    const after = updateAssetTags(lib, "ast_a", filled);
    expect(after.assets["ast_a"].tags).toEqual(filled);
    expect(lib.assets["ast_a"].tags.pending).toBe(true);
  });

  it("throws for an unknown id", () => {
    expect(() => updateAssetTags(emptyLibrary("biz_123"), "ast_x", pendingTags())).toThrow(/ast_x/);
  });
});

describe("archiveAsset", () => {
  it("flips status to archived without deleting the record", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const after = archiveAsset(lib, "ast_a");
    expect(after.assets["ast_a"].status).toBe("archived");
    expect(lib.assets["ast_a"].status).toBe("active");
  });

  it("throws for an unknown id", () => {
    expect(() => archiveAsset(emptyLibrary("biz_123"), "ast_x")).toThrow(/ast_x/);
  });
});

describe("recordUsage", () => {
  it("appends a usage entry to the reverse index", () => {
    const lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const after = recordUsage(lib, "ast_a", { alias: "hero-image", route: "/", section: "HeroSection" });
    expect(after.assets["ast_a"].usages).toEqual([{ alias: "hero-image", route: "/", section: "HeroSection" }]);
    expect(lib.assets["ast_a"].usages).toEqual([]);
  });

  it("de-duplicates identical usage entries", () => {
    let lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    const usage = { alias: "hero-image", route: "/", section: "HeroSection" };
    lib = recordUsage(lib, "ast_a", usage);
    lib = recordUsage(lib, "ast_a", usage);
    expect(lib.assets["ast_a"].usages).toHaveLength(1);
  });

  it("records two different placements of the same asset", () => {
    let lib = addAsset(emptyLibrary("biz_123"), fixtureAsset("ast_a"));
    lib = recordUsage(lib, "ast_a", { alias: "hero-image", route: "/", section: "HeroSection" });
    lib = recordUsage(lib, "ast_a", { alias: "about-photo", route: "/about/", section: "AboutSection" });
    expect(lib.assets["ast_a"].usages).toHaveLength(2);
  });

  it("throws for an unknown id", () => {
    expect(() => recordUsage(emptyLibrary("biz_123"), "ast_x", { alias: "a", route: "/", section: "S" })).toThrow(/ast_x/);
  });
});
