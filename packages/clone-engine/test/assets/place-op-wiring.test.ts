import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditOpSchema } from "../../src/edit/types.ts";
import { plan } from "../../src/edit/plan.ts";
import { placeAsset } from "../../src/edit/place.ts";
import { emptyLibrary, addAsset, saveLibrary, loadLibrary, type Asset } from "../../src/assets/library.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function libAsset(id: string): Asset {
  return {
    id, source: "upload", file: `library/${id}.png`, mime: "image/png",
    dimensions: { w: 1, h: 1 }, aspectRatio: "1:1", bytes: PNG_1x1.length,
    tags: { pending: false, hasPeople: false, subjects: ["barbell"], mood: [], setting: "product", description: "A barbell.", quality: "high" },
    usages: [], status: "active", createdAt: "2026-08-02T00:00:00.000Z",
  };
}

function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "place-"));
  for (const d of ["astro/public/assets", "assets", "astro/src/components", "library"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, "astro/public/assets/a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "assets/a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "library/ast_new.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "astro/src/components/HeroSection.astro"), `---\nconst content = [];\n---\n<section data-component="HeroSection"><img src="/assets/a1.png" /></section>\n`);
  fs.writeFileSync(path.join(dir, "astro/brand.json"), JSON.stringify({ colors: { primary: { hex: "#000", value: "rgb(0,0,0)", variants: {} }, accent: { hex: "#111", value: "rgb(17,17,17)", variants: {} }, surface: { hex: "#fff", value: "rgb(255,255,255)", variants: {} }, text: { hex: "#222", value: "rgb(34,34,34)", variants: {} }, muted: { hex: "#888", value: "rgb(136,136,136)", variants: {} } }, space: {}, radius: {} }));
  const manifest = { pages: [{ route: "/", component: "HomePage", type: "home", goal: "trust", sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }], elements: [], assets: [{ alias: "hero-image", file: "assets/a1.png" }], copy: [] }] };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  saveLibrary(dir, addAsset(emptyLibrary("biz_1"), libAsset("ast_new")));
  return { dir };
}

function fakeChat(json: string): ChatFn {
  return async (): Promise<ChatResponse> => ({ content: json, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
}

describe("EditOpSchema — placeAsset", () => {
  it("accepts a valid placeAsset op", () => {
    const parsed = EditOpSchema.parse({ op: "placeAsset", alias: "hero-image", assetId: "ast_new" });
    expect(parsed).toEqual({ op: "placeAsset", alias: "hero-image", assetId: "ast_new" });
  });
  it("rejects a placeAsset op missing assetId", () => {
    expect(() => EditOpSchema.parse({ op: "placeAsset", alias: "hero-image" })).toThrow();
  });
});

describe("placeAsset (op impl)", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("swaps the file, stamps assetId onto site.json, and records the usage", async () => {
    const res = await placeAsset(site, "hero-image", "ast_new");
    expect(res.targetSections).toContain("HeroSection");
    const manifest = JSON.parse(fs.readFileSync(path.join(site.dir, "site.json"), "utf8"));
    const entry = manifest.pages[0].assets.find((a: { alias: string }) => a.alias === "hero-image");
    expect(entry.assetId).toBe("ast_new");
    const lib = loadLibrary(site.dir, "biz_1");
    expect(lib.assets["ast_new"].usages.some((u) => u.alias === "hero-image")).toBe(true);
  });

  it("throws a TargetError for an unknown assetId", async () => {
    await expect(placeAsset(site, "hero-image", "ast_missing")).rejects.toThrow(/ast_missing/);
  });

  it("throws for an archived assetId", async () => {
    const { archiveAsset } = await import("../../src/assets/library.ts");
    saveLibrary(site.dir, archiveAsset(loadLibrary(site.dir, "biz_1"), "ast_new"));
    await expect(placeAsset(site, "hero-image", "ast_new")).rejects.toThrow(/archived/i);
  });
});

describe("plan validates placeAsset", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("keeps a placeAsset op whose alias + assetId both exist", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "place library asset", ops: [{ op: "placeAsset", alias: "hero-image", assetId: "ast_new" }] }));
    const result = await plan(site, [{ role: "user", content: "put ast_new in the hero" }], chat, "m");
    expect(result.needsInfo).toBe(false);
    if (!result.needsInfo) expect(result.ops[0].op).toBe("placeAsset");
  });

  it("drops a placeAsset op whose assetId does NOT exist → needsInfo:true", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "bad", ops: [{ op: "placeAsset", alias: "hero-image", assetId: "ast_ghost" }] }));
    const result = await plan(site, [{ role: "user", content: "place a ghost" }], chat, "m");
    expect(result.needsInfo).toBe(true);
  });

  it("drops a placeAsset op whose alias does NOT exist → needsInfo:true", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "bad", ops: [{ op: "placeAsset", alias: "no-such-alias", assetId: "ast_new" }] }));
    const result = await plan(site, [{ role: "user", content: "place into nowhere" }], chat, "m");
    expect(result.needsInfo).toBe(true);
  });
});
