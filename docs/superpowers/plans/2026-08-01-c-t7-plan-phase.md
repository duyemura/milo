# Clone Engine — Subsystem C, Task 7: Plan Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `plan` phase of subsystem C — a clarifying-dialogue planner that converts a natural-language edit request into validated `EditOp[]` (or asks clarifying questions), with the LLM mocked in tests.

**Architecture:** Two new files (`digest.ts` — pure token-budget function, no LLM; `plan.ts` — LLM + post-validation) plus additions to `types.ts` (new `SiteDigest`, `ConversationTurn` types, `EditOpSchema` Zod union). `digest` builds a compact JSON view of the site from `site.json`; `plan` passes it to `llmJson`, then post-validates every returned op against the real site using existing `target.ts` resolvers. Hallucinated ops are dropped; if all ops drop, result degrades to `needsInfo: true`. The `EditOpSchema` (Zod discriminated union) is the reusable contract T8 (apply) will use to parse plan output.

**Tech Stack:** TypeScript 5, Zod 3, `@milo/llm` (`llmJson`, `ChatFn`, `ChatMessage`), `vitest`, existing `target.ts` resolvers, existing `SiteRef` + `SiteManifest` types.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/clone-engine/src/edit/types.ts` | **Modify** | Add `SiteDigest`, `ConversationTurn`; add `EditOpSchema` Zod union (8 discriminated variants) |
| `packages/clone-engine/src/edit/digest.ts` | **Create** | `digest(site): SiteDigest` — pure, token-budgeted JSON view of a projected site |
| `packages/clone-engine/src/edit/plan.ts` | **Create** | `plan(site, conversation, chat, model): Promise<PlanResult>` — calls LLM, post-validates ops, downgrade logic |
| `packages/clone-engine/src/edit/index.ts` | **Modify** | Re-export `digest`, `plan`, and new types from `types.ts` |
| `packages/clone-engine/test/edit/plan.test.ts` | **Create** | 4 test cases with mocked LLM via local `fakeChat`; uses a lightweight in-memory SiteRef fixture |

---

## Task 1 — Add `SiteDigest`, `ConversationTurn`, and `EditOpSchema` to `types.ts`

**Files:**
- Modify: `packages/clone-engine/src/edit/types.ts`

> **Read first:** `packages/clone-engine/src/edit/types.ts` (the existing `EditOp` union and `PlanResult`), `packages/clone-engine/src/types.ts` (for `SiteManifest` shape reference).

- [ ] **Step 1: Read `types.ts` to confirm the existing `EditOp` union and `PlanResult`**

Run: `cat -n packages/clone-engine/src/edit/types.ts`

Expected: you see the 8-variant `EditOp` union and the `PlanResult` interface.

- [ ] **Step 2: Write the failing test for `EditOpSchema` shape** (test in Task 4, but we write the Zod schema here — verify it compiles first)

This step is just adding the code. The test gate is Task 4.

- [ ] **Step 3: Add `SiteDigest`, `ConversationTurn`, and `EditOpSchema` to `types.ts`**

Add **after** the existing `STYLE_PROPS` export (end of file):

```typescript
import { z } from "zod";

// ---------------------------------------------------------------------------
// SiteDigest — compact token-budgeted site view for the planner prompt
// ---------------------------------------------------------------------------

/** A single copy slot preview included in the site digest. */
export interface DigestCopyEntry {
  key: string;
  /** Truncated text preview, max 60 chars. */
  preview: string;
}

/** Compact representation of one section on one page. */
export interface DigestSection {
  name: string;
  role: string;
  /** All copy slots owned by this section, with short previews. */
  copyKeys: DigestCopyEntry[];
  /** Element roles inside this section. */
  elementRoles: string[];
  /** Asset aliases that reference this section (inferred from manifest). */
  assetAliases: string[];
}

/** Compact representation of one page. */
export interface DigestPage {
  route: string;
  sections: DigestSection[];
}

/** Brand slot names and their current hex colors. */
export interface DigestBrand {
  primary: string;
  accent: string;
  surface: string;
  text: string;
  muted: string;
}

/**
 * Token-budgeted site view passed to the planner LLM.
 * Keep it small — this goes in the system/user prompt.
 */
export interface SiteDigest {
  pages: DigestPage[];
  brand: DigestBrand;
  /** All asset aliases across all pages (deduplicated). */
  assetAliases: string[];
}

// ---------------------------------------------------------------------------
// ConversationTurn — single dialogue turn for the planner
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// EditOpSchema — Zod discriminated union mirroring EditOp (8 variants)
// Reusable by T8 (apply phase) to parse plan output safely.
// ---------------------------------------------------------------------------

const StylePropZ = z.enum([
  "font-size", "font-weight", "font-style", "text-align", "padding", "margin",
  "background-color", "color", "width", "max-width", "display",
  "grid-template-columns", "gap",
]);

const BrandSlotZ = z.enum(["primary", "accent", "surface", "text", "muted"]);

export const EditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("editCopy"), copyKey: z.string(), text: z.string() }),
  z.object({ op: z.literal("setBrand"), slot: BrandSlotZ, value: z.string() }),
  z.object({ op: z.literal("swapAsset"), alias: z.string(), source: z.string() }),
  z.object({ op: z.literal("styleTweak"), target: z.string(), prop: StylePropZ, value: z.string() }),
  z.object({ op: z.literal("removeSection"), section: z.string() }),
  z.object({ op: z.literal("reorderSection"), section: z.string(), toIndex: z.number().int().nonnegative() }),
  z.object({ op: z.literal("addSection"), cloneOf: z.string(), afterSection: z.string().optional() }),
  z.object({ op: z.literal("addPage"), route: z.string(), cloneOfPage: z.string().optional() }),
]);

/** The full PlanResult schema for the LLM to fill (needsInfo=true XOR needsInfo=false). */
export const PlanSchema = z.discriminatedUnion("needsInfo", [
  z.object({
    needsInfo: z.literal(true),
    questions: z.array(z.string()).min(1).max(3),
  }),
  z.object({
    needsInfo: z.literal(false),
    ops: z.array(EditOpSchema).min(1),
    summary: z.string(),
  }),
]);

export type PlanSchemaOutput = z.infer<typeof PlanSchema>;
```

- [ ] **Step 4: Run `tsc --noEmit` to confirm no type errors**

```bash
cd /Users/dan/pushpress/milo && node packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine/tsconfig.json
```

Expected: no output (clean).

---

## Task 2 — Create `src/edit/digest.ts`

**Files:**
- Create: `packages/clone-engine/src/edit/digest.ts`

> **Read first:** `packages/clone-engine/src/types.ts` (full `SiteManifest` shape), `packages/clone-engine/src/edit/target.ts` (`loadSite`), the new `SiteDigest` type added in Task 1.

`digest` is a **pure function** — no LLM, no side effects beyond reading `site.json` and `astro/brand.json`. The token budget is enforced by truncating copy previews to ≤60 chars and deduplicitating asset aliases.

- [ ] **Step 1: Write the failing test** (in `test/edit/plan.test.ts`, Task 4) — here we just implement.

- [ ] **Step 2: Create `digest.ts`**

```typescript
/**
 * digest.ts — compact, token-budgeted site view for the planner prompt.
 *
 * Pure function: reads site.json + astro/brand.json, returns SiteDigest.
 * No LLM, no side effects beyond file reads.
 */
import fs from "node:fs";
import path from "node:path";
import { loadSite } from "./target.ts";
import type { SiteRef } from "./types.ts";
import type { SiteDigest, DigestPage, DigestSection, DigestBrand } from "./types.ts";
import type { BrandDoc } from "../types.ts";

const PREVIEW_LEN = 60;

function truncate(text: string): string {
  return text.length <= PREVIEW_LEN ? text : text.slice(0, PREVIEW_LEN - 1) + "…";
}

/**
 * Build a compact JSON site view for inclusion in the planner prompt.
 *
 * Includes per page: sections (name, role, copyKeys with short previews, elementRoles,
 * assetAliases), and brand slot colors. Keeps payload small — this goes in the prompt.
 */
export function digest(site: SiteRef): SiteDigest {
  const manifest = loadSite(site);

  // Collect all asset aliases (deduplicated across pages).
  const allAliases = new Set<string>();
  for (const page of manifest.pages) {
    for (const asset of page.assets) {
      allAliases.add(asset.alias);
    }
  }

  const pages: DigestPage[] = manifest.pages.map((page) => {
    const sections: DigestSection[] = page.sections.map((section) => {
      // Copy entries owned by this section, with truncated previews.
      const copyKeys = page.copy
        .filter((c) => c.component === section.name)
        .map((c) => ({ key: c.key, preview: truncate(c.text) }));

      // Element roles inside this section.
      const elementRoles = page.elements
        .filter((e) => e.component === section.name)
        .map((e) => e.role);

      // Asset aliases whose files are referenced by this section (any page asset for now,
      // since the manifest doesn't store per-section asset links — return all page aliases).
      const assetAliases = page.assets.map((a) => a.alias);

      return {
        name: section.name,
        role: section.role,
        copyKeys,
        elementRoles,
        assetAliases,
      };
    });

    return { route: page.route, sections };
  });

  // Read brand.json for color slots. Fall back gracefully if absent.
  const brand = loadBrand(site);

  return {
    pages,
    brand,
    assetAliases: [...allAliases],
  };
}

function loadBrand(site: SiteRef): DigestBrand {
  const brandPath = path.join(site.dir, "astro", "brand.json");
  const fallback: DigestBrand = {
    primary: "unknown",
    accent: "unknown",
    surface: "unknown",
    text: "unknown",
    muted: "unknown",
  };

  if (!fs.existsSync(brandPath)) return fallback;

  try {
    const doc = JSON.parse(fs.readFileSync(brandPath, "utf8")) as BrandDoc;
    const colors = doc.colors as Record<string, { hex?: string; value?: string }>;
    return {
      primary: colors.primary?.hex ?? colors.primary?.value ?? "unknown",
      accent: colors.accent?.hex ?? colors.accent?.value ?? "unknown",
      surface: colors.surface?.hex ?? colors.surface?.value ?? "unknown",
      text: colors.text?.hex ?? colors.text?.value ?? "unknown",
      muted: colors.muted?.hex ?? colors.muted?.value ?? "unknown",
    };
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 3: Run `tsc --noEmit`**

```bash
cd /Users/dan/pushpress/milo && node packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine/tsconfig.json
```

Expected: no output (clean).

---

## Task 3 — Create `src/edit/plan.ts`

**Files:**
- Create: `packages/clone-engine/src/edit/plan.ts`

> **Read first:** `packages/clone-engine/src/edit/target.ts` (all resolvers + `TargetError`), `packages/llm/src/llm-json.ts` (the `llmJson` signature), `packages/clone-engine/src/labels.ts` lines 778–789 (canonical `llmJson` call pattern), the new `EditOpSchema`, `PlanSchema`, `SiteDigest`, `ConversationTurn` from Task 1.

`plan` orchestrates three concerns:
1. **Digest** — call `digest(site)` to get the compact JSON view.
2. **LLM call** — call `llmJson(PlanSchema, { chat, model, messages })` where `messages` includes a system prompt + the digest + the conversation.
3. **Post-validate** — for each returned op, call the matching `target.ts` resolver. Drop ops that throw `TargetError`. If ALL ops get dropped, downgrade to `needsInfo: true`.

- [ ] **Step 1: Create `plan.ts`**

```typescript
/**
 * plan.ts — clarifying-dialogue planner for subsystem C (T7).
 *
 * Turns a natural-language edit conversation into a validated PlanResult:
 *   - needsInfo: true + questions[]  — when request is vague or targets can't be validated
 *   - needsInfo: false + ops[] + summary — when request is clear + all targets exist
 *
 * The LLM output is post-validated against the REAL site (via target.ts resolvers) so
 * hallucinated copy keys / section names / asset aliases are always dropped before
 * returning. If all ops are dropped, the result degrades to needsInfo: true with a
 * clarifying question explaining the mismatch.
 */
import type { SiteRef, EditOp, PlanResult, ConversationTurn } from "./types.ts";
import { PlanSchema, EditOpSchema } from "./types.ts";
import { digest } from "./digest.ts";
import {
  resolveCopy,
  resolveSection,
  resolveAsset,
  resolveElement,
  TargetError,
  loadSite,
} from "./target.ts";
import { llmJson } from "@milo/llm";
import type { ChatFn, ChatMessage } from "@milo/llm";

const SYSTEM_PROMPT = `You edit ONE gym website. Given the site digest and the conversation, determine the user's intent.

If the request is CLEAR and SPECIFIC:
- Output a list of edit ops from the schema (1–5 ops), each targeting a REAL identifier from the digest.
- Add a plain-language summary (1–3 sentences) of what you will change.
- Set needsInfo to false.

If the request is VAGUE or UNDERSPECIFIED (missing which section, which copy, what value, etc.):
- Ask 1–3 clarifying questions to understand WHAT they want changed and WHY.
- Set needsInfo to true.

NEVER invent targets. Only reference:
- copyKeys that appear in the digest (e.g. "HeroSection.0")
- section names or roles from the digest (e.g. "hero", "HeroSection")
- asset aliases from the digest (e.g. "logo")
- brand slots: primary, accent, surface, text, muted
- element roles from the digest

Output valid JSON matching the schema. No markdown, no prose outside the JSON.`;

/**
 * Run the planner. Returns a PlanResult validated against the real site.
 *
 * @param site - SiteRef pointing to the projected out dir (must have site.json + brand.json).
 * @param conversation - The dialogue so far. The LAST entry should be the pending user request.
 * @param chat - Injectable ChatFn (real or mocked).
 * @param model - Model string passed to the LLM.
 */
export async function plan(
  site: SiteRef,
  conversation: ConversationTurn[],
  chat: ChatFn,
  model: string,
): Promise<PlanResult> {
  const siteDigest = digest(site);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Site digest:\n${JSON.stringify(siteDigest, null, 2)}`,
    },
    ...conversation.map((t) => ({ role: t.role, content: t.content })),
  ];

  const raw = await llmJson(PlanSchema, { chat, model, messages, temperature: 0.2 });

  if (raw.needsInfo) {
    return { needsInfo: true, questions: raw.questions };
  }

  // Post-validate each op against the real site.
  const validated: EditOp[] = [];
  const dropped: Array<{ op: unknown; reason: string }> = [];

  for (const op of raw.ops) {
    try {
      validateOpTarget(site, op);
      validated.push(op as EditOp);
    } catch (err) {
      const reason = err instanceof TargetError ? err.message : String(err);
      dropped.push({ op, reason });
      console.warn(`[plan] dropped hallucinated op (${(op as { op: string }).op}): ${reason}`);
    }
  }

  if (dropped.length > 0) {
    console.warn(`[plan] ${dropped.length} op(s) dropped due to hallucinated targets`);
  }

  // If ALL ops were dropped, downgrade to needsInfo.
  if (validated.length === 0) {
    return {
      needsInfo: true,
      questions: [
        "I couldn't find the elements you described on this site. " +
        "Could you clarify which section, text, or element you'd like to change? " +
        "I can list available sections and copy keys if that helps.",
      ],
    };
  }

  return { needsInfo: false, ops: validated, summary: raw.summary };
}

/**
 * Validate that an op's targets exist in the real site.json.
 * Throws `TargetError` if any target is missing (hallucinated).
 */
function validateOpTarget(site: SiteRef, op: unknown): void {
  // Cast through EditOpSchema to get a typed op.
  const parsed = EditOpSchema.parse(op);

  switch (parsed.op) {
    case "editCopy":
      resolveCopy(site, parsed.copyKey);
      break;

    case "setBrand": {
      // Validate brand slot exists in the manifest brand field (it's always one of the 5 enum values,
      // enforced by Zod — no additional runtime check needed beyond schema parse above).
      const manifest = loadSite(site);
      // brand field in site.json is a path string (e.g. "astro/brand.json") — slot validity
      // guaranteed by the Zod enum. Nothing to throw here.
      void manifest;
      break;
    }

    case "swapAsset":
      resolveAsset(site, parsed.alias);
      break;

    case "styleTweak":
      // target can be an element role or a section role/name — try both.
      try {
        resolveElement(site, parsed.target);
      } catch {
        // If resolveElement throws TargetError, try resolveSection.
        resolveSection(site, parsed.target);
      }
      break;

    case "removeSection":
    case "reorderSection":
      resolveSection(site, parsed.section);
      break;

    case "addSection":
      resolveSection(site, parsed.cloneOf);
      if (parsed.afterSection !== undefined) {
        // afterSection is advisory — don't throw if missing, just log.
        try {
          resolveSection(site, parsed.afterSection);
        } catch {
          console.warn(`[plan] addSection.afterSection "${parsed.afterSection}" not found — will append at end`);
        }
      }
      break;

    case "addPage": {
      // route must be non-empty (Zod already checks z.string(), we add a runtime guard).
      if (!parsed.route || parsed.route.trim() === "") {
        throw new TargetError("addPage: route must be non-empty");
      }
      // cloneOfPage, if provided, must match a page in the manifest.
      if (parsed.cloneOfPage !== undefined) {
        const manifest = loadSite(site);
        const found = manifest.pages.find(
          (p) => p.route === parsed.cloneOfPage || p.component === parsed.cloneOfPage,
        );
        if (!found) {
          throw new TargetError(`addPage: cloneOfPage not found in site.json: ${parsed.cloneOfPage}`);
        }
      }
      break;
    }
  }
}
```

- [ ] **Step 2: Run `tsc --noEmit`**

```bash
cd /Users/dan/pushpress/milo && node packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine/tsconfig.json
```

Expected: no output (clean). Fix any type errors before moving on.

---

## Task 4 — Create `test/edit/plan.test.ts` with mocked LLM

**Files:**
- Create: `packages/clone-engine/test/edit/plan.test.ts`

> **Read first:** `packages/llm/test/llm-json.test.ts` (canonical `fakeChat` helper), `packages/clone-engine/test/edit/ops.test.ts` (how a SiteRef is built from `projectFixture`), the `digest` and `plan` function signatures.

The test uses a **lightweight in-memory fixture** rather than a full `projectFixture()` call: we write a minimal `site.json` + `astro/brand.json` to a temp dir. This avoids Playwright/browser startup and keeps the test fast (no `beforeAll` timeout needed). We use a local `fakeChat` that returns scripted JSON strings, exactly like `packages/llm/test/llm-json.test.ts`.

**Fixture design:** The minimal site.json must have at least one page with:
- `sections[0]` with `name: "HeroSection"`, `role: "hero"`, `copyKeys: ["HeroSection.0"]`
- `copy[0]` with `key: "HeroSection.0"`, `component: "HeroSection"`, `index: 0`, `text: "Welcome to CrossFit Iron Anchor"`
- `assets[0]` with `alias: "logo"`, `file: "assets/logo.png"`
- `elements[0]` with `role: "headline"`, `id: "p1"`, `component: "HeroSection"`, `selector: "[data-component=HeroSection] [data-role=headline]"`

The `astro/brand.json` must have a minimal `colors` object with `primary`, `accent`, `surface`, `text`, `muted` keys each having `hex` and `value`.

- [ ] **Step 1: Write the test file**

```typescript
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
      (o) => o.op === "removeSection" && o.section === "NONEXISTENT_SECTION_XYZ",
    );
    expect(hasRemovedBogus).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run just the plan tests to verify they pass**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/plan.test.ts
```

Expected: 4 tests pass. Fix any errors before moving on.

- [ ] **Step 3: Run the full edit test suite to ensure no regressions**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/
```

Expected: all tests pass (existing ops.test.ts, revert.test.ts, types.test.ts, verify.test.ts, scenario/*, and the new plan.test.ts).

---

## Task 5 — Update `src/edit/index.ts` to re-export new modules

**Files:**
- Modify: `packages/clone-engine/src/edit/index.ts`

> **Read first:** the current contents of `packages/clone-engine/src/edit/index.ts`.

- [ ] **Step 1: Add exports for `digest` and `plan` to `index.ts`**

Current content is:
```typescript
export * from "./types.ts";
export * from "./target.ts";
export * from "./ops.ts";
export * from "./history.ts";
```

Add two lines after `./history.ts`:
```typescript
export * from "./digest.ts";
export * from "./plan.ts";
```

- [ ] **Step 2: Run `tsc --noEmit` to confirm clean compile**

```bash
cd /Users/dan/pushpress/milo && node packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine/tsconfig.json
```

Expected: no output (clean).

---

## Task 6 — Final gate + commit

- [ ] **Step 1: Run the target test file**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/plan.test.ts
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 2: Run the full edit test suite**

```bash
cd /Users/dan/pushpress/milo/packages/clone-engine && pnpm vitest run --no-file-parallelism test/edit/
```

Expected: all tests pass (ops, revert, types, verify, scenario/clone, scenario/reflow, plan).

- [ ] **Step 3: Run `tsc --noEmit` (full package)**

```bash
cd /Users/dan/pushpress/milo && node packages/clone-engine/node_modules/.bin/tsc --noEmit -p packages/clone-engine/tsconfig.json
```

Expected: no output (clean).

- [ ] **Step 4: Confirm correct branch**

```bash
git -C /Users/dan/pushpress/milo branch --show-current
```

Expected: `page-clone-engine`

- [ ] **Step 5: Stage and commit only the plan-phase files**

```bash
cd /Users/dan/pushpress/milo && git add \
  packages/clone-engine/src/edit/types.ts \
  packages/clone-engine/src/edit/digest.ts \
  packages/clone-engine/src/edit/plan.ts \
  packages/clone-engine/src/edit/index.ts \
  packages/clone-engine/test/edit/plan.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd /Users/dan/pushpress/milo && git commit -m "feat(edit): plan phase — clarifying dialogue + target validation (mocked LLM) (C-T7)"
```

Expected: commit succeeds. Verify with `git log --oneline -1`.

---

## Self-Review

**Spec coverage:**
- "Step 1 — `digest.ts`: `digest(site: SiteRef): SiteDigest`" ✓ Task 2
- "Step 2 — `plan.ts`: `plan(site, conversation, chat, model)`" ✓ Task 3
- "Build a Zod schema forcing EITHER `needsInfo: true` OR `needsInfo: false`" ✓ Task 1 (`PlanSchema`)
- "Build `EditOpSchema` as a Zod discriminated union mirroring the 8 `EditOp` variants" ✓ Task 1 (`EditOpSchema`)
- "Post-validate EVERY op's target against the real site using `target.ts` resolvers" ✓ Task 3 (`validateOpTarget`)
- "If ALL ops get dropped, downgrade to `{ needsInfo: true, questions: [...] }`" ✓ Task 3
- "Step 3 — tests via `fakeChat`" ✓ Task 4
- "Test 1: clear request → validated ops" ✓ Task 4
- "Test 2: vague request → questions" ✓ Task 4
- "Test 3: hallucinated target → dropped → downgrade" ✓ Task 4
- "Test 4: one real + one bogus → only real survives" ✓ Task 4
- "Update `index.ts`" ✓ Task 5
- "Commit with explicit paths" ✓ Task 6

**Type consistency check:**
- `ConversationTurn` defined in `types.ts` Task 1, used in `plan.ts` Task 3 ✓
- `SiteDigest` defined in `types.ts` Task 1, returned by `digest.ts` Task 2 ✓
- `EditOpSchema` defined in `types.ts` Task 1, used in `plan.ts` Task 3's `validateOpTarget` ✓
- `PlanSchema` defined in `types.ts` Task 1, passed to `llmJson` in `plan.ts` ✓
- `PlanResult` already exists in `types.ts` (not re-defined), returned by `plan` ✓
- `fakeChat` in `plan.test.ts` returns `{ content: string }` — matches `ChatResponse` partial ✓

**Placeholder scan:** None found.

**T8 readiness:** `EditOpSchema` is exported from `types.ts` via `index.ts`. T8 (apply) can import it with `import { EditOpSchema } from "@milo/clone-engine"` or `from "../edit/types.ts"` and call `EditOpSchema.parse(op)` before dispatching to `ops.ts`. The `ConversationTurn` type is also available for any plan→apply pipeline.
