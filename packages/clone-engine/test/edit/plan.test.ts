/**
 * plan.test.ts — T7 planner, LLM mocked via fakeChat. No browser, no real API.
 *
 * Tests:
 *   1. Clear request → validated ops present (real copy key).
 *   2. Vague request → questions returned (needsInfo: true).
 *   3. Hallucinated target → op dropped → downgrade to needsInfo: true.
 *   4. Mixed bag → one real + one bogus → only real op survives, needsInfo: false.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plan } from "../../src/edit/plan.ts";
import type { SiteRef, ConversationTurn } from "../../src/edit/types.ts";
import type { ChatFn } from "@milo/llm";

// ---------------------------------------------------------------------------
// Minimal fixture — written to a temp dir once for all tests.
// No browser, no Playwright, no project() call.
// ---------------------------------------------------------------------------

let outDir: string;
let site: SiteRef;

const MINIMAL_MANIFEST = {
  brand: "astro/brand.json",
  pages: [
    {
      route: "/",
      component: "HomePage",
      sections: [
        {
          name: "HeroSection",
          role: "hero",
          file: "astro/src/components/HeroSection.astro",
          copyKeys: ["HeroSection.0", "HeroSection.1"],
          elementRoles: [{ role: "headline", id: "p1" }],
        },
        {
          name: "CtaSection",
          role: "cta",
          file: "astro/src/components/CtaSection.astro",
          copyKeys: ["CtaSection.0"],
          elementRoles: [],
        },
      ],
      elements: [
        {
          role: "headline",
          id: "p1",
          component: "HeroSection",
          selector: '[data-component="HeroSection"] [data-role="headline"]',
        },
      ],
      assets: [
        { alias: "logo", file: "assets/logo.png" },
      ],
      copy: [
        { key: "HeroSection.0", component: "HeroSection", index: 0, text: "Welcome to CrossFit Iron Anchor" },
        { key: "HeroSection.1", component: "HeroSection", index: 1, text: "Join the strongest community in town" },
        { key: "CtaSection.0", component: "CtaSection", index: 0, text: "Get started today" },
      ],
    },
  ],
};

const MINIMAL_BRAND = {
  colors: {
    primary: { hex: "#1a1a2e", value: "rgb(26, 26, 46)", variants: {} },
    accent:  { hex: "#e94560", value: "rgb(233, 69, 96)",  variants: {} },
    surface: { hex: "#16213e", value: "rgb(22, 33, 62)",   variants: {} },
    text:    { hex: "#ffffff", value: "rgb(255, 255, 255)", variants: {} },
    muted:   { hex: "#a8a8b3", value: "rgb(168, 168, 179)", variants: {} },
  },
  space: {},
  radius: {},
};

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
  site = { dir: outDir };

  // Write site.json.
  fs.writeFileSync(path.join(outDir, "site.json"), JSON.stringify(MINIMAL_MANIFEST, null, 2));

  // Write astro/brand.json.
  const brandDir = path.join(outDir, "astro");
  fs.mkdirSync(brandDir, { recursive: true });
  fs.writeFileSync(path.join(brandDir, "brand.json"), JSON.stringify(MINIMAL_BRAND, null, 2));
});

afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fakeChat helper — returns scripted JSON responses in order.
// ---------------------------------------------------------------------------

function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

const MODEL = "test-model";
const CLEAR_REQUEST: ConversationTurn[] = [
  { role: "user", content: "Change the hero headline to 'Train Hard. Live Strong.'" },
];
const VAGUE_REQUEST: ConversationTurn[] = [
  { role: "user", content: "Make it look better" },
];

// ---------------------------------------------------------------------------
// Test 1 — Clear request → validated ops present
// ---------------------------------------------------------------------------

describe("plan — clear request with real copy key", () => {
  it("returns needsInfo:false with the validated editCopy op", async () => {
    const llmResponse = JSON.stringify({
      needsInfo: false,
      ops: [{ op: "editCopy", copyKey: "HeroSection.0", text: "Train Hard. Live Strong." }],
      summary: "Updated the hero headline copy.",
    });

    const result = await plan(site, CLEAR_REQUEST, fakeChat([llmResponse]), MODEL);

    expect(result.needsInfo).toBe(false);
    expect(result.ops).toHaveLength(1);
    expect(result.ops![0]).toEqual({
      op: "editCopy",
      copyKey: "HeroSection.0",
      text: "Train Hard. Live Strong.",
    });
    expect(result.summary).toBeTypeOf("string");
    expect(result.summary!.length).toBeGreaterThan(0);
    // No questions on a confident plan.
    expect(result.questions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Vague request → questions returned
// ---------------------------------------------------------------------------

describe("plan — vague request", () => {
  it("returns needsInfo:true with clarifying questions", async () => {
    const llmResponse = JSON.stringify({
      needsInfo: true,
      questions: [
        "Which section would you like to update — the hero, CTA, or another area?",
        "What specifically would you like to change — text, colors, or layout?",
      ],
    });

    const result = await plan(site, VAGUE_REQUEST, fakeChat([llmResponse]), MODEL);

    expect(result.needsInfo).toBe(true);
    expect(result.questions).toHaveLength(2);
    expect(result.ops).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Hallucinated target → drop → downgrade to needsInfo
// ---------------------------------------------------------------------------

describe("plan — hallucinated copy key → all ops dropped", () => {
  it("downgrades to needsInfo:true when the only op has a bogus target", async () => {
    const llmResponse = JSON.stringify({
      needsInfo: false,
      ops: [{ op: "editCopy", copyKey: "BOGUS_KEY_DOES_NOT_EXIST.99", text: "something" }],
      summary: "Changed a headline that doesn't exist.",
    });

    const result = await plan(site, CLEAR_REQUEST, fakeChat([llmResponse]), MODEL);

    expect(result.needsInfo).toBe(true);
    // Should ask a clarifying question, not return the bogus op.
    expect(result.questions).toBeDefined();
    expect(result.questions!.length).toBeGreaterThan(0);
    // The bogus op must not appear anywhere.
    expect(result.ops).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Mixed ops: one real, one bogus → only the real one survives
// ---------------------------------------------------------------------------

describe("plan — mixed real + hallucinated ops", () => {
  it("keeps the real op and drops the bogus one, returns needsInfo:false", async () => {
    const llmResponse = JSON.stringify({
      needsInfo: false,
      ops: [
        { op: "editCopy", copyKey: "HeroSection.1", text: "Forge your best self." },
        { op: "removeSection", section: "NONEXISTENT_SECTION_XYZ" },
      ],
      summary: "Updated hero copy and removed a section.",
    });

    const result = await plan(site, CLEAR_REQUEST, fakeChat([llmResponse]), MODEL);

    expect(result.needsInfo).toBe(false);
    expect(result.ops).toHaveLength(1);
    expect(result.ops![0]).toEqual({
      op: "editCopy",
      copyKey: "HeroSection.1",
      text: "Forge your best self.",
    });
    // The bogus removeSection op must not appear.
    const hasRemovedBogus = result.ops?.some(
      (o) => o.op === "removeSection" && (o as { section?: string }).section === "NONEXISTENT_SECTION_XYZ",
    );
    expect(hasRemovedBogus).toBeFalsy();
  });
});
