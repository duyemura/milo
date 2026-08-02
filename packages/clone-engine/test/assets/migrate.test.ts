import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateExistingAssets } from "../../src/assets/migrate.ts";
import { loadLibrary } from "../../src/assets/library.ts";
import type { SiteRef } from "../../src/edit/types.ts";

const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR42mNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function makeTwoPageSite(): SiteRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  const assets = path.join(dir, "assets");
  const components = path.join(dir, "astro", "src", "components");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(components, { recursive: true });
  for (const f of ["logo.png", "hero.png", "about.png"]) fs.writeFileSync(path.join(assets, f), PNG_2x1);
  fs.writeFileSync(path.join(components, "HeroSection.astro"), `<section data-component="HeroSection"><img src="/assets/hero.png" /><img src="/assets/logo.png" /></section>`);
  fs.writeFileSync(path.join(components, "AboutSection.astro"), `<section data-component="AboutSection"><img src="/assets/about.png" /><img src="/assets/logo.png" /></section>`);
  const manifest = {
    pages: [
      { route: "/", component: "HomePage", type: "home", goal: "trust",
        sections: [{ name: "HeroSection", role: "hero", file: "astro/src/components/HeroSection.astro", copyKeys: [], elementRoles: [] }],
        elements: [], copy: [],
        assets: [{ alias: "hero-image", file: "assets/hero.png" }, { alias: "logo", file: "assets/logo.png" }] },
      { route: "/about/", component: "AboutPage", type: "content", goal: "trust",
        sections: [{ name: "AboutSection", role: "content", file: "astro/src/components/AboutSection.astro", copyKeys: [], elementRoles: [] }],
        elements: [], copy: [],
        assets: [{ alias: "about-photo", file: "assets/about.png" }, { alias: "logo", file: "assets/logo.png" }] },
    ],
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir };
}

describe("migrateExistingAssets", () => {
  let site: SiteRef;
  beforeEach(() => { site = makeTwoPageSite(); });
  afterEach(() => { fs.rmSync(site.dir, { recursive: true, force: true }); });

  it("catalogs every distinct file as upload and links assetId back into site.json", async () => {
    const res = await migrateExistingAssets(site.dir, site, { businessId: "biz_1" });
    expect(res.catalogued).toBe(3); // hero, about, logo
    const lib = loadLibrary(site.dir, "biz_1");
    expect(Object.keys(lib.assets)).toHaveLength(3);
    for (const a of Object.values(lib.assets)) expect(a.source).toBe("upload");
    const manifest = JSON.parse(fs.readFileSync(path.join(site.dir, "site.json"), "utf8"));
    for (const page of manifest.pages) for (const a of page.assets) expect(a.assetId).toMatch(/^ast_/);
    // Shared logo maps to ONE library asset with two route usages
    const logoId = manifest.pages[0].assets.find((a: { alias: string }) => a.alias === "logo").assetId;
    expect(manifest.pages[1].assets.find((a: { alias: string }) => a.alias === "logo").assetId).toBe(logoId);
    expect(lib.assets[logoId].usages.map((u) => u.route).sort()).toEqual(["/", "/about/"]);
  });

  it("is idempotent — a second run catalogs nothing new", async () => {
    await migrateExistingAssets(site.dir, site, { businessId: "biz_1" });
    const again = await migrateExistingAssets(site.dir, site, { businessId: "biz_1" });
    expect(again.catalogued).toBe(0);
    expect(again.skipped).toBeGreaterThan(0);
    expect(Object.keys(loadLibrary(site.dir, "biz_1").assets)).toHaveLength(3);
  });
});
