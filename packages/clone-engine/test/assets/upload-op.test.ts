import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadAsset } from "../../src/edit/place.ts";
import { loadLibrary } from "../../src/assets/library.ts";
import { EditOpSchema } from "../../src/edit/types.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR42mNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function tagsChat(): ChatFn {
  return async (): Promise<ChatResponse> => ({
    content: JSON.stringify({ hasPeople: true, subjects: ["coach", "member"], mood: ["welcoming"], setting: "interior", description: "Two members training together.", quality: "high" }),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
}

function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
  for (const d of ["astro/public/assets", "assets", "astro/src/components"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, "astro/public/assets/a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "assets/a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(dir, "astro/src/components/HeroSection.astro"), `---\nconst content = [];\n---\n<section data-component="HeroSection"><img src="/assets/a1.png" /></section>\n`);
  const manifest = { pages: [{ route: "/", component: "HomePage", type: "home", goal: "trust", sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }], elements: [], assets: [{ alias: "hero-image", file: "assets/a1.png" }], copy: [] }] };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

describe("EditOpSchema — uploadAsset", () => {
  it("accepts a valid uploadAsset op", () => {
    const parsed = EditOpSchema.parse({ op: "uploadAsset", file: "/tmp/x.png", alias: "hero-image", altText: "our gym" });
    expect(parsed.op).toBe("uploadAsset");
  });
});

describe("uploadAsset (op impl)", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("ingests as source:'upload' and places it", async () => {
    const src = path.join(os.tmpdir(), `upload-src-${Date.now()}.png`);
    fs.writeFileSync(src, PNG_2x1);
    try {
      const res = await uploadAsset(site, src, "hero-image", { altText: "our members", chat: tagsChat(), model: "m" });
      expect(res.op.op).toBe("uploadAsset");
      expect(res.targetSections).toContain("HeroSection");
      const lib = loadLibrary(site.dir, "biz_unknown");
      const asset = lib.assets[Object.keys(lib.assets)[0]];
      expect(asset.source).toBe("upload");
      expect(asset.altText).toBe("our members");
      expect(asset.usages.some((u) => u.alias === "hero-image")).toBe(true);
    } finally { fs.rmSync(src, { force: true }); }
  });

  it("preserves hasPeople:true for uploaded photos (uploads are the only people path)", async () => {
    const src = path.join(os.tmpdir(), `upload-people-${Date.now()}.png`);
    fs.writeFileSync(src, PNG_2x1);
    try {
      await uploadAsset(site, src, "hero-image", { chat: tagsChat(), model: "m" });
      const lib = loadLibrary(site.dir, "biz_unknown");
      const asset = lib.assets[Object.keys(lib.assets)[0]];
      expect(asset.tags.hasPeople).toBe(true);
    } finally { fs.rmSync(src, { force: true }); }
  });
});
