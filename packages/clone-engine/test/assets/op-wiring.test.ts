import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plan } from "../../src/edit/plan.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-wiring-"));
  const publicAssets = path.join(dir, "astro", "public", "assets");
  const components = path.join(dir, "astro", "src", "components");
  const styles = path.join(dir, "astro", "src", "styles");
  const rootAssets = path.join(dir, "assets");
  fs.mkdirSync(publicAssets, { recursive: true });
  fs.mkdirSync(components, { recursive: true });
  fs.mkdirSync(styles, { recursive: true });
  fs.mkdirSync(rootAssets, { recursive: true });
  fs.writeFileSync(path.join(publicAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(rootAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(components, "HeroSection.astro"), `---\nconst content = [];\n---\n<section><img src="/assets/a1.png" /></section>\n`);
  fs.writeFileSync(path.join(dir, "astro", "brand.json"), JSON.stringify({ colors: { primary: { hex: "#000", value: "rgb(0,0,0)", variants: {} }, accent: { hex: "#111", value: "rgb(17,17,17)", variants: {} }, surface: { hex: "#fff", value: "rgb(255,255,255)", variants: {} }, text: { hex: "#222", value: "rgb(34,34,34)", variants: {} }, muted: { hex: "#888", value: "rgb(136,136,136)", variants: {} } }, space: {}, radius: {} }));
  const manifest = { pages: [{ route: "/", component: "HomePage", type: "home", goal: "trust", sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }], elements: [], assets: [{ alias: "hero-image", file: "assets/a1.png" }], copy: [] }] };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

function fakeChat(json: string): ChatFn {
  return async (): Promise<ChatResponse> => ({ content: json, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
}

describe("plan validates generateAsset alias", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("keeps a generateAsset op whose alias exists", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "regen hero", ops: [{ op: "generateAsset", alias: "hero-image", brief: "a barbell" }] }));
    const result = await plan(site, [{ role: "user", content: "regenerate the hero image as a barbell" }], chat, "test-model");
    expect(result.needsInfo).toBe(false);
    if (!result.needsInfo) {
      expect(result.ops).toHaveLength(1);
      expect(result.ops[0].op).toBe("generateAsset");
    }
  });

  it("drops a generateAsset op whose alias does NOT exist — all ops dropped → needsInfo:true", async () => {
    const chat = fakeChat(JSON.stringify({ needsInfo: false, summary: "regen missing", ops: [{ op: "generateAsset", alias: "does-not-exist", brief: "a barbell" }] }));
    const result = await plan(site, [{ role: "user", content: "regenerate the nonexistent image" }], chat, "test-model");
    // All ops dropped → plan downgrades to needsInfo:true
    expect(result.needsInfo).toBe(true);
  });
});
