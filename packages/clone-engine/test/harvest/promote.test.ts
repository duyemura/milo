import { describe, it, expect } from "vitest";
import { applyPopularityFloor, needsHumanGate, selfPruneMerge } from "../../src/harvest/promote.ts";
import { clusterArchetypes } from "../../src/harvest/library.ts";
import { videoBgHero, imageBgHero, ctaLeft } from "./fixtures.ts";

describe("popularity floor", () => {
  it("quarantines an archetype seen on <= floor sites", () => {
    const arch = clusterArchetypes([ctaLeft]); // 1 site
    const gated = applyPopularityFloor(arch, 2);
    expect(Object.values(gated)[0].status).toBe("quarantine");
  });
  it("promotes an archetype above the floor to candidate", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]); // 2 distinct sites
    const gated = applyPopularityFloor(arch, 1);
    expect(Object.values(gated)[0].status).toBe("candidate");
  });
});

describe("human gate", () => {
  it("flags every first-time candidate as needing review", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    const a = Object.values(applyPopularityFloor(arch, 1))[0];
    expect(needsHumanGate(a, new Set())).toBe(true);
  });
  it("does not re-gate an already-admitted fingerprint", () => {
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    const a = Object.values(applyPopularityFloor(arch, 1))[0];
    expect(needsHumanGate(a, new Set([a.fingerprint.hash]))).toBe(false);
  });
});

describe("self-prune merge", () => {
  it("merges two archetypes that share role+slotTree+layout but were split by a knob", () => {
    // Build two archetypes with the SAME fingerprint hash (simulating a fingerprint refinement).
    const arch = clusterArchetypes([videoBgHero, imageBgHero]);
    const [k, v] = Object.entries(arch)[0];
    const merged = selfPruneMerge({ [k]: v, [k + "b"]: { ...v, sites: ["siteX"] } });
    // both share the real hash k after refinement → collapse to one, union of sites
    expect(Object.keys(merged)).toHaveLength(1);
    expect(Object.values(merged)[0].sites.sort()).toEqual(["siteA", "siteB", "siteX"]);
  });
});
