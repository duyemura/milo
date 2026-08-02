import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clusterArchetypes, emptyLibrary, saveLibrary, loadLibrary } from "../../src/harvest/library.ts";
import { fingerprint } from "../../src/harvest/fingerprint.ts";
import { videoBgHero, imageBgHero, ctaLeft, ctaRight, grid3, grid6 } from "./fixtures.ts";

describe("clusterArchetypes", () => {
  it("collapses same-fingerprint sections into ONE archetype (promote-by-novelty)", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    expect(Object.keys(arch)).toHaveLength(1);
    const only = Object.values(arch)[0];
    expect(only.sites.sort()).toEqual(["siteA", "siteB"]); // popularity=2, distinct sites
  });

  it("counts a site ONCE even if it repeats a pattern (site-level popularity)", () => {
    const dup = { ...videoBgHero, sourceSite: "siteA" }; // same site as videoBgHero
    const arch = clusterArchetypes([videoBgHero, dup, imageBgHero]);
    const only = Object.values(arch)[0];
    expect(only.sites.sort()).toEqual(["siteA", "siteB"]);
  });

  it("keeps distinct content models as separate archetypes", () => {
    const arch = clusterArchetypes([ctaLeft, ctaRight, grid3, grid6]);
    expect(Object.keys(arch)).toHaveLength(2); // cta-band (1) + feature-grid (1)
  });

  it("enumerates knobs on the archetype from its members", () => {
    const arch = clusterArchetypes([ctaLeft, ctaRight]);
    const only = Object.values(arch)[0];
    expect(only.knobs.align.sort()).toEqual(["left", "right"]);
  });
});

describe("library persistence", () => {
  it("round-trips through JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
    const lib = emptyLibrary();
    lib.archetypes = clusterArchetypes([grid3, grid6]);
    const file = path.join(dir, "library.json");
    saveLibrary(file, lib);
    const back = loadLibrary(file);
    expect(Object.keys(back.archetypes)).toEqual(Object.keys(lib.archetypes));
  });

  it("loadLibrary returns an empty library when the file does not exist", () => {
    const lib = loadLibrary(path.join(os.tmpdir(), "nope-" + Date.now() + ".json"));
    expect(lib.version).toBe(1);
    expect(Object.keys(lib.archetypes)).toHaveLength(0);
  });
});
