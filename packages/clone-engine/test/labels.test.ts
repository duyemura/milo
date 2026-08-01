/**
 * labels.test.ts — heuristic labeler + LLM-labeler (mocked) tests.
 *
 * Heuristic (Task 0), per golden site:
 * 1. LabelSchema.parse() doesn't throw  (schema validity)
 * 2. Two calls produce deep-equal output  (determinism)
 * 3. Sanity: brand.colors has primary + surface; sections.length > 0; headline element present
 *
 * LLM path (Task 6) — the LLM is ALWAYS mocked via `fakeChat`. NO real API calls:
 * 4. llmLabels with valid canned JSON → validates + produces expected roles.
 * 5. label({llm:true}) with garbage JSON → falls back to heuristic (deep-equal to heuristic output).
 * 6. Hallucination guard: LLM emits a fake section id / off-palette color → dropped/snapped, still valid.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { heuristicLabels, llmLabels, buildDigest, label, LabelSchema } from "../src/labels.ts";
import type { CaptureJson, Labels } from "../src/types.ts";
import type { ChatFn } from "@milo/llm";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SITES = ["torrance", "speakeasy", "sweatshed"] as const;

function loadCapture(site: string): CaptureJson {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "golden", site, "capture.json"), "utf8"),
  ) as CaptureJson;
}

/** Round-robin fake chat — same pattern as @milo/llm's llm-json.test.ts. */
function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

describe("heuristicLabels", () => {
  for (const site of SITES) {
    describe(site, () => {
      const cap = loadCapture(site);
      const labels = heuristicLabels(cap);

      it("validates against LabelSchema", () => {
        expect(() => LabelSchema.parse(labels)).not.toThrow();
      });

      it("is deterministic (two calls deep-equal)", () => {
        expect(heuristicLabels(cap)).toEqual(heuristicLabels(cap));
      });

      it("sanity: has primary color, surface color, sections, and headline element", () => {
        const colorSlots = labels.brand.colors.map((c) => c.slot);
        expect(colorSlots).toContain("primary");
        expect(colorSlots).toContain("surface");
        expect(labels.sections.length).toBeGreaterThan(0);
        const validRoles = new Set([
          "hero", "faq", "program-cards", "coach-grid", "testimonials", "pricing",
          "cta-band", "feature-grid", "location-map", "schedule", "stats-band",
          "logo-strip", "media-block", "content-block", "contact-form", "lead-form", "unknown",
        ]);
        for (const sec of labels.sections) {
          expect(validRoles).toContain(sec.role);
        }
        const elementRoles = labels.elements.map((e) => e.role);
        expect(elementRoles).toContain("headline");
        expect(labels.site.name.length).toBeGreaterThan(0);
      });
    });
  }
});

describe("buildDigest", () => {
  it("emits compact sections/colors/fonts/assets referencing real capture data", () => {
    const cap = loadCapture("torrance");
    const digest = buildDigest(cap);

    // section ids in the digest are real capture ids
    const heur = heuristicLabels(cap);
    const realSectionIds = new Set(heur.sections.map((s) => s.id));
    expect(digest.sections.length).toBeGreaterThan(0);
    for (const s of digest.sections) expect(realSectionIds.has(s.id)).toBe(true);

    // colors carry the "r,g,b,a" canon strings + usage context
    expect(digest.colors.length).toBeGreaterThan(0);
    for (const c of digest.colors) expect(c.canon).toMatch(/^\d+,\d+,\d+,[\d.]+$/);

    // vocabulary is embedded so the model can only pick valid roles/slots
    expect(digest.roleVocabulary).toContain("hero");
    expect(digest.colorSlots).toContain("primary");
  });
});

describe("llmLabels (mocked LLM — no real API)", () => {
  it("validates canned LLM JSON and produces the labeled roles", async () => {
    const cap = loadCapture("torrance");
    const digest = buildDigest(cap);
    const firstSectionId = digest.sections[0].id;
    const secondSectionId = digest.sections[1]?.id ?? firstSectionId;
    const paletteCanon = digest.colors[0].canon;

    const canned: Labels = {
      site: { name: "Torrance Training", purpose: "gym landing page" },
      brand: {
        colors: [{ slot: "primary", canon: paletteCanon }],
        fonts: [{ slot: "display", family: "Oswald" }],
      },
      sections: [
        { id: firstSectionId, name: "HeroSection", role: "hero" },
        { id: secondSectionId, name: "ProgramsSection", role: "program-cards" },
      ],
      elements: [],
      assets: [],
    };

    const labels = await llmLabels(cap, fakeChat([JSON.stringify(canned)]), "mock-model");
    expect(() => LabelSchema.parse(labels)).not.toThrow();
    const hero = labels.sections.find((s) => s.id === firstSectionId);
    expect(hero?.role).toBe("hero");
    expect(labels.brand.colors.find((c) => c.slot === "primary")?.canon).toBe(paletteCanon);
    expect(labels.site.name).toBe("Torrance Training");
  });

  it("hallucination guard: drops fake section ids + snaps off-palette colors", async () => {
    const cap = loadCapture("torrance");
    const digest = buildDigest(cap);
    const realSectionId = digest.sections[0].id;
    const fakeSectionId = 9_999_999; // not in the capture

    const canned: Labels = {
      site: { name: "Torrance", purpose: "gym" },
      brand: {
        // off-palette color the LLM "invented" — must snap to a real captured canon
        colors: [{ slot: "primary", canon: "123,45,200,1" }],
        fonts: [],
      },
      sections: [
        { id: realSectionId, name: "HeroSection", role: "hero" },
        { id: fakeSectionId, name: "GhostSection", role: "faq" },
      ],
      elements: [
        { id: realSectionId, role: "headline" }, // real id kept
        { id: fakeSectionId, role: "primary-cta" }, // fake id dropped
      ],
      assets: [{ file: "assets/does-not-exist.png", alias: "logo" }], // fake file dropped
    };

    const labels = await llmLabels(cap, fakeChat([JSON.stringify(canned)]), "mock-model");
    expect(() => LabelSchema.parse(labels)).not.toThrow();

    // fake section id gone; real one kept
    const ids = labels.sections.map((s) => s.id);
    expect(ids).toContain(realSectionId);
    expect(ids).not.toContain(fakeSectionId);

    // fake element id dropped
    expect(labels.elements.map((e) => e.id)).not.toContain(fakeSectionId);

    // off-palette primary snapped to a REAL captured canon (never the invented one)
    const validCanons = new Set(digest.colors.map((c) => c.canon));
    const primary = labels.brand.colors.find((c) => c.slot === "primary");
    expect(primary).toBeDefined();
    expect(primary!.canon).not.toBe("123,45,200,1");
    expect(validCanons.has(primary!.canon)).toBe(true);

    // fake asset file dropped
    expect(labels.assets.map((a) => a.file)).not.toContain("assets/does-not-exist.png");
  });

  it("font guard: a hallucinated font family snaps to a captured font (never leaks into brand.json)", async () => {
    const cap = loadCapture("torrance");
    // The set of font-families that actually appear in the 1440 capture.
    const capturedFamilies = new Set(
      Object.values(cap.styles["1440"] ?? {})
        .map((s) => s["font-family"])
        .filter((f): f is string => Boolean(f)),
    );

    const canned: Labels = {
      site: { name: "Torrance", purpose: "gym" },
      brand: {
        colors: [],
        // A font the capture never used — must NOT survive into the labels.
        fonts: [{ slot: "display", family: "Totally Made Up Font 9000" }],
      },
      sections: [],
      elements: [],
      assets: [],
    };

    const labels = await llmLabels(cap, fakeChat([JSON.stringify(canned)]), "mock-model");
    expect(() => LabelSchema.parse(labels)).not.toThrow();

    const display = labels.brand.fonts.find((f) => f.slot === "display");
    if (display) {
      // If a display slot survives, its family MUST be a real captured font (snapped),
      // never the hallucinated string.
      expect(display.family).not.toBe("Totally Made Up Font 9000");
      expect(capturedFamilies.has(display.family)).toBe(true);
    }
    // A real captured family passes through unchanged.
    const realFamily = [...capturedFamilies][0];
    const canned2: Labels = {
      ...canned,
      brand: { colors: [], fonts: [{ slot: "body", family: realFamily }] },
    };
    const labels2 = await llmLabels(cap, fakeChat([JSON.stringify(canned2)]), "mock-model");
    expect(labels2.brand.fonts.find((f) => f.slot === "body")?.family).toBe(realFamily);
  });

  it("throws when the LLM never produces valid JSON (caller handles fallback)", async () => {
    const cap = loadCapture("torrance");
    await expect(
      llmLabels(cap, fakeChat(["not json", "still not json", "nope"]), "mock-model"),
    ).rejects.toThrow(/LLM failed to produce valid JSON/);
  });
});

describe("label() — LLM is an enhancement, never a dependency", () => {
  function writeCapture(site: string): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "milo-labels-"));
    fs.copyFileSync(
      path.join(dir, "golden", site, "capture.json"),
      path.join(tmp, "capture.json"),
    );
    return tmp;
  }

  it("garbage LLM JSON → falls back to heuristicLabels (byte-identical to heuristic)", async () => {
    const cap = loadCapture("torrance");
    const heur = heuristicLabels(cap);
    const tmp = writeCapture("torrance");

    // Force the LLM path on (mock the provider + model via env), but make the
    // provider return garbage. `label()` must swallow the error and use the heuristic.
    const prev = { p: process.env.LLM_PROVIDER, m: process.env.DEFAULT_LLM_MODEL };
    // NOTE: we cannot inject a fakeChat into label() directly — it constructs the real
    // chatCompletion from env. Instead we point it at an unreachable/invalid config so
    // the real call fails fast, exercising the SAME fallback branch as an LLM error.
    process.env.LLM_PROVIDER = "openrouter";
    process.env.DEFAULT_LLM_MODEL = "mock-model";
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:1/v1"; // refused connection
    process.env.OPENROUTER_API_KEY = "test";
    try {
      const labels = await label({ dir: tmp, llm: true });
      expect(labels).toEqual(heur); // fell back to the deterministic heuristic
      expect(() => LabelSchema.parse(labels)).not.toThrow();
    } finally {
      process.env.LLM_PROVIDER = prev.p;
      process.env.DEFAULT_LLM_MODEL = prev.m;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("llm:false → heuristic path even if a provider is configured", async () => {
    const cap = loadCapture("speakeasy");
    const heur = heuristicLabels(cap);
    const tmp = writeCapture("speakeasy");
    const prev = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = "openrouter";
    try {
      const labels = await label({ dir: tmp, llm: false });
      expect(labels).toEqual(heur);
    } finally {
      process.env.LLM_PROVIDER = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no LLM_PROVIDER → heuristic path", async () => {
    const cap = loadCapture("sweatshed");
    const heur = heuristicLabels(cap);
    const tmp = writeCapture("sweatshed");
    const prev = process.env.LLM_PROVIDER;
    delete process.env.LLM_PROVIDER;
    try {
      const labels = await label({ dir: tmp });
      expect(labels).toEqual(heur);
    } finally {
      if (prev !== undefined) process.env.LLM_PROVIDER = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
