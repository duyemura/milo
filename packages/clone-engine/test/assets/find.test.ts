import { describe, it, expect } from "vitest";
import { findAsset } from "../../src/assets/find.ts";
import { emptyLibrary, addAsset, type Asset, type AssetLibrary, type AssetTags } from "../../src/assets/library.ts";

function tags(over: Partial<AssetTags> = {}): AssetTags {
  return { pending: false, hasPeople: false, subjects: [], mood: [], setting: "product", description: "", quality: "high", ...over };
}
function asset(id: string, over: Partial<Asset> = {}, tagOver: Partial<AssetTags> = {}): Asset {
  return { id, source: "upload", file: `library/${id}.webp`, mime: "image/webp", dimensions: { w: 1600, h: 900 }, aspectRatio: "16:9", bytes: 100, tags: tags(tagOver), usages: [], status: "active", createdAt: "2026-08-01T00:00:00.000Z", ...over };
}
function libOf(...assets: Asset[]): AssetLibrary {
  return assets.reduce((lib, a) => addAsset(lib, a), emptyLibrary("biz_1"));
}

describe("findAsset — hard filters", () => {
  it("excludes archived assets", () => {
    const lib = libOf(asset("ast_a", { status: "archived" }), asset("ast_b"));
    expect(findAsset(lib, {}).map((a) => a.id)).toEqual(["ast_b"]);
  });
  it("filters by aspectRatio", () => {
    const lib = libOf(asset("ast_wide", { aspectRatio: "16:9" }), asset("ast_sq", { aspectRatio: "1:1" }));
    expect(findAsset(lib, { aspectRatio: "1:1" }).map((a) => a.id)).toEqual(["ast_sq"]);
  });
  it("filters by setting", () => {
    const lib = libOf(asset("ast_food", {}, { setting: "food" }), asset("ast_prod", {}, { setting: "product" }));
    expect(findAsset(lib, { setting: "food" }).map((a) => a.id)).toEqual(["ast_food"]);
  });
  it("filters by hasPeople", () => {
    const lib = libOf(asset("ast_people", {}, { hasPeople: true }), asset("ast_clean", {}, { hasPeople: false }));
    expect(findAsset(lib, { hasPeople: false }).map((a) => a.id)).toEqual(["ast_clean"]);
  });
  it("usableContext 'generated-safe' excludes hasPeople assets", () => {
    const lib = libOf(asset("ast_people", {}, { hasPeople: true }), asset("ast_clean", {}, { hasPeople: false }));
    expect(findAsset(lib, { usableContext: "generated-safe" }).map((a) => a.id)).toEqual(["ast_clean"]);
  });
  it("minQuality keeps assets at or above the threshold", () => {
    const lib = libOf(asset("ast_low", {}, { quality: "low" }), asset("ast_med", {}, { quality: "medium" }), asset("ast_high", {}, { quality: "high" }));
    expect(findAsset(lib, { minQuality: "medium" }).map((a) => a.id).sort()).toEqual(["ast_high", "ast_med"]);
  });
});

describe("findAsset — ranking", () => {
  it("ranks by recency when no embedding available", () => {
    const older = asset("ast_old", { createdAt: "2026-08-01T00:00:00.000Z" });
    const newer = asset("ast_new", { createdAt: "2026-08-02T00:00:00.000Z" });
    expect(findAsset(libOf(older, newer), {}).map((a) => a.id)).toEqual(["ast_new", "ast_old"]);
  });
  it("ranks by cosine similarity when query and candidates have embeddings", () => {
    const near = asset("ast_near", { createdAt: "2026-08-01T00:00:00.000Z" }, { embedding: [0.9, 0.1, 0] });
    const far = asset("ast_far", { createdAt: "2026-08-02T00:00:00.000Z" }, { embedding: [0, 0, 1] });
    expect(findAsset(libOf(near, far), { embedding: [1, 0, 0] }).map((a) => a.id)).toEqual(["ast_near", "ast_far"]);
  });
  it("falls back to recency when candidates lack embeddings", () => {
    const a = asset("ast_a", { createdAt: "2026-08-01T00:00:00.000Z" });
    const b = asset("ast_b", { createdAt: "2026-08-02T00:00:00.000Z" });
    expect(findAsset(libOf(a, b), { embedding: [1, 0, 0] }).map((x) => x.id)).toEqual(["ast_b", "ast_a"]);
  });
  it("respects limit", () => {
    expect(findAsset(libOf(asset("ast_a"), asset("ast_b"), asset("ast_c")), { limit: 2 })).toHaveLength(2);
  });
  it("returns [] when nothing matches", () => {
    expect(findAsset(libOf(asset("ast_a", {}, { setting: "product" })), { setting: "food" })).toEqual([]);
  });
});

describe("findAsset — text search", () => {
  it("matches description words", () => {
    const a = asset("ast_a", {}, { description: "Two members high-fiving after a workout." });
    expect(findAsset(libOf(a), { text: "members" }).map((x) => x.id)).toContain("ast_a");
  });

  it("matches subjects", () => {
    const a = asset("ast_a", {}, { subjects: ["barbell", "squat rack"], description: "" });
    expect(findAsset(libOf(a), { text: "barbell" }).map((x) => x.id)).toContain("ast_a");
  });

  it("matches mood terms", () => {
    const a = asset("ast_a", {}, { mood: ["celebratory", "energetic"], description: "" });
    expect(findAsset(libOf(a), { text: "celebratory" }).map((x) => x.id)).toContain("ast_a");
  });

  it("requires ALL query words to match somewhere in the searchable text", () => {
    const happy = asset("ast_happy", {}, { description: "Members smiling after class." });
    const unrelated = asset("ast_other", {}, { description: "A barbell on the floor." });
    const lib = libOf(happy, unrelated);
    // "members smiling" — both words in description → match
    expect(findAsset(lib, { text: "members smiling" }).map((x) => x.id)).toContain("ast_happy");
    expect(findAsset(lib, { text: "members smiling" }).map((x) => x.id)).not.toContain("ast_other");
  });

  it("is case-insensitive", () => {
    const a = asset("ast_a", {}, { description: "A Barbell close-up." });
    expect(findAsset(libOf(a), { text: "BARBELL" }).map((x) => x.id)).toContain("ast_a");
  });

  it("excludes an asset when a required word is absent", () => {
    const highFive = asset("ast_hf", {}, { description: "Members high-fiving.", mood: ["energetic"] });
    // "smiling" not in description/subjects/mood → no match
    expect(findAsset(libOf(highFive), { text: "smiling" })).toHaveLength(0);
  });

  it("text search + hard filters stack — both must pass", () => {
    const a = asset("ast_a", { aspectRatio: "16:9" }, { description: "A barbell." });
    const b = asset("ast_b", { aspectRatio: "1:1" }, { description: "A barbell." });
    // both match text, only "16:9" matches the filter
    expect(findAsset(libOf(a, b), { text: "barbell", aspectRatio: "16:9" }).map((x) => x.id)).toEqual(["ast_a"]);
  });
});
