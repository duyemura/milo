import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateAsset } from "../../src/assets/generate.ts";
import type { SiteRef } from "../../src/edit/types.ts";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function makeFixtureSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-asset-"));
  const publicAssets = path.join(dir, "astro", "public", "assets");
  const rootAssets = path.join(dir, "assets");
  const components = path.join(dir, "astro", "src", "components");
  fs.mkdirSync(publicAssets, { recursive: true });
  fs.mkdirSync(rootAssets, { recursive: true });
  fs.mkdirSync(components, { recursive: true });
  fs.writeFileSync(path.join(publicAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(rootAssets, "a1.png"), PNG_1x1);
  fs.writeFileSync(path.join(components, "HeroSection.astro"), `---\nconst content = [];\n---\n<section data-component="HeroSection"><img src="/assets/a1.png" /></section>\n`);
  const manifest = { pages: [{ route: "/", component: "HomePage", type: "home", goal: "trust", sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }], elements: [], assets: [{ alias: "hero-image", file: "assets/a1.png" }], copy: [] }] };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

function stubFetch(opts: { imageUrl: string; fluxOk?: boolean; imageBytes?: Buffer }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("fal.run")) {
      if (opts.fluxOk === false) return new Response("upstream error", { status: 500 });
      return new Response(JSON.stringify({ images: [{ url: opts.imageUrl }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const imgBody = (opts.imageBytes ?? PNG_1x1) as unknown as BodyInit;
    return new Response(imgBody, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function tmpFilesUnder(_dir: string): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("gen-asset-img-"));
}

describe("generateAsset", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeFixtureSite(); process.env.FAL_API_KEY = "test-key"; });
  afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(site.dir, { recursive: true, force: true }); for (const n of tmpFilesUnder(os.tmpdir())) fs.rmSync(path.join(os.tmpdir(), n), { force: true }); });

  it("happy path: classifies, generates, downloads, and swaps the asset", async () => {
    const { fn, calls } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/generated.png" });
    const result = await generateAsset(site, { alias: "hero-image", brief: "close-up of a competition kettlebell on a neutral background" });
    expect(result.ok).toBe(true);
    expect(result.assetAlias).toBe("hero-image");
    expect(result.failures).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[0].url).toContain("fal.run");
    expect(calls[1].url).toBe("https://cdn.fal.ai/out/generated.png");
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.prompt).toContain("kettlebell");
    expect(body.prompt).toContain("no people");
    expect(body.image_size).toBe("landscape_16_9");
    expect(body.num_images).toBe(1);
    const headers = new Headers(calls[0].init!.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Key test-key");
    expect(tmpFilesUnder(os.tmpdir())).toEqual([]);
  });

  it("honors an explicit category override", async () => {
    const { calls } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/x.png" });
    const result = await generateAsset(site, { alias: "hero-image", brief: "a plain object", category: "texture" });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.prompt).toContain("Abstract texture photograph");
  });

  it("refuses an unsafe brief BEFORE any network call", async () => {
    const { fn } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/x.png" });
    const result = await generateAsset(site, { alias: "hero-image", brief: "a person lifting weights in our gym" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/people|bodies|not allowed/i);
    expect(fn).not.toHaveBeenCalled();
    const comp = fs.readFileSync(path.join(site.dir, "astro", "src", "components", "HeroSection.astro"), "utf8");
    expect(comp).toContain("/assets/a1.png");
  });

  it("fails cleanly when Flux returns a non-2xx", async () => {
    const { fn } = stubFetch({ imageUrl: "unused", fluxOk: false });
    const result = await generateAsset(site, { alias: "hero-image", brief: "a barbell close-up" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/flux|fal\.ai|500|generation/i);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(tmpFilesUnder(os.tmpdir())).toEqual([]);
  });

  it("explicit category still runs refusal check — unsafe brief refused even with category set", async () => {
    const { fn } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/x.png" });
    const result = await generateAsset(site, { alias: "hero-image", brief: "a person lifting weights", category: "product" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/people|bodies|not allowed/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it("maps aspectRatio 1:1 to square_hd", async () => {
    const { calls } = stubFetch({ imageUrl: "https://cdn.fal.ai/out/sq.png" });
    await generateAsset(site, { alias: "hero-image", brief: "a kettlebell", aspectRatio: "1:1" });
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.image_size).toBe("square_hd");
  });
});
