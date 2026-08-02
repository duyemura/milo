import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addNavLink } from "../../src/edit/ops.ts";
import type { SiteRef } from "../../src/edit/types.ts";

/** Build a minimal site dir with a fake Navbar.astro containing a <ul> with links. */
function makeNavSite(): { siteDir: string; site: SiteRef } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-test-"));
  const compsDir = path.join(dir, "astro/src/components");
  fs.mkdirSync(compsDir, { recursive: true });

  // Minimal Navbar component with a <ul> nav list
  fs.writeFileSync(path.join(compsDir, "Navbar.astro"), [
    "---",
    'const content = ["Home", "About", "Programs"];',
    'const e = (s) => String(s);',
    "const html = `<nav><ul><li><a href=\"/\">Home</a></li><li><a href=\"/about/\">About</a></li></ul></nav>`;",
    "---",
    "<Fragment set:html={html} />",
  ].join("\n"));

  const siteJson = {
    brand: "astro/brand.json",
    pages: [{
      route: "/", component: "Index", type: "home", goal: "convert",
      sections: [{ name: "Navbar", role: "navbar", file: "astro/src/components/Navbar.astro", copyKeys: [], elementRoles: [] }],
      elements: [], assets: [], copy: [],
    }],
  };
  fs.writeFileSync(path.join(dir, "site.json"), JSON.stringify(siteJson));
  return { siteDir: dir, site: { dir } };
}

describe("addNavLink", () => {
  it("adds a new link to the nav <ul>", () => {
    const { siteDir, site } = makeNavSite();
    addNavLink(site, "Contact", "/contact/");
    const src = fs.readFileSync(path.join(siteDir, "astro/src/components/Navbar.astro"), "utf8");
    expect(src).toContain('href="/contact/"');
    expect(src).toContain("Contact");
  });

  it("inserts before </ul> so it's inside the nav list", () => {
    const { siteDir, site } = makeNavSite();
    addNavLink(site, "Blog", "/blog/");
    const src = fs.readFileSync(path.join(siteDir, "astro/src/components/Navbar.astro"), "utf8");
    const contactIdx = src.indexOf("/blog/");
    const ulEndIdx = src.indexOf("</ul>");
    expect(contactIdx).toBeLessThan(ulEndIdx);
  });

  it("is idempotent — adding same href twice only adds once", () => {
    const { site } = makeNavSite();
    addNavLink(site, "Blog", "/blog/");
    addNavLink(site, "Blog", "/blog/");
    const src = fs.readFileSync(path.join(site.dir, "astro/src/components/Navbar.astro"), "utf8");
    expect(src.split('href="/blog/"').length - 1).toBe(1);
  });

  it("returns changedFiles with the nav component path", () => {
    const { site } = makeNavSite();
    const result = addNavLink(site, "Events", "/events/");
    expect(result.changedFiles.some((f) => f.includes("Navbar.astro"))).toBe(true);
  });
});
