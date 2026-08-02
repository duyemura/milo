/**
 * eval-llm.ts — MANUAL real-LLM eval for the plan + apply pipeline (C-T9).
 *
 * NOT a CI test — skipped unless LLM_PROVIDER is configured.
 * Run manually to generate an eval report:
 *   cd packages/clone-engine
 *   LLM_PROVIDER=openrouter DEFAULT_LLM_MODEL=google/gemini-2.5-flash \
 *     OPENROUTER_API_KEY=<key> OPENROUTER_BASE_URL=https://openrouter.ai/api/v1 \
 *     pnpm vitest run test/edit/eval-llm.ts
 *
 * Or from repo root with .env loaded:
 *   cd packages/clone-engine && \
 *   node --env-file=../../.env node_modules/.bin/vitest run test/edit/eval-llm.ts
 *
 * Three NL edit requests are run through the full plan → apply pipeline:
 *   1. "make the primary color blue"
 *   2. "change the main headline to something more energetic"
 *   3. "remove the testimonials section"
 *
 * Results are logged and asserted at a lenient threshold: we only gate on
 * plan() not throwing (the model must produce *some* answer). apply() results
 * are logged for honest review but not strictly gated (this is an eval, not CI).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../src/project.ts";
import { plan } from "../../src/edit/plan.ts";
import { apply } from "../../src/edit/apply.ts";
import { snapshot, revert } from "../../src/edit/history.ts";
import { chatCompletion } from "@milo/llm";
import type { LlmConfig, ChatFn } from "@milo/llm";
import type { SiteRef, ConversationTurn } from "../../src/edit/types.ts";
import type { SiteManifest } from "../../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN = path.join(dir, "../golden/speakeasy");

// ---------------------------------------------------------------------------
// LLM config from env
// ---------------------------------------------------------------------------

function buildChatFromEnv(): { chat: ChatFn; model: string } | null {
  const provider = process.env.LLM_PROVIDER;
  if (provider !== "openrouter" && provider !== "ollama") return null;
  const model = process.env.DEFAULT_LLM_MODEL;
  if (!model) return null;
  const config: LlmConfig = {
    provider,
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaApiKey: process.env.OLLAMA_API_KEY,
  };
  return { chat: (o) => chatCompletion(o, config), model };
}

const env = buildChatFromEnv();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function findAstroModules(): string | null {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(REPO, "page-clone-spike/out-project-page/astro/node_modules"),
    path.join(PKG, "node_modules"),
    path.join(REPO, "node_modules"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}
const ASTRO_MODULES = findAstroModules();

let out: string;
let site: SiteRef;
let browser: Browser;

beforeAll(async () => {
  if (!env || !ASTRO_MODULES) return;
  process.env.ASTRO_MODULES = ASTRO_MODULES;
  out = fs.mkdtempSync(path.join(os.tmpdir(), "eval-llm-"));
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  site = { dir: out };
  snapshot(site);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  if (browser) await browser.close();
  if (out && fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Eval requests
// ---------------------------------------------------------------------------

const REQUESTS: Array<{ label: string; conversation: ConversationTurn[] }> = [
  {
    label: "primary-color-blue",
    conversation: [{ role: "user", content: "Make the primary brand color blue, use #0066ff." }],
  },
  {
    label: "headline-copy",
    conversation: [{ role: "user", content: "Change the main hero headline to something more energetic and motivational." }],
  },
  {
    label: "remove-testimonials",
    conversation: [{ role: "user", content: "Remove the testimonials or stories section from the page." }],
  },
];

describe.skipIf(!env || !ASTRO_MODULES)("real-LLM eval: plan + apply pipeline", () => {
  for (const req of REQUESTS) {
    it(`eval: ${req.label}`, async () => {
      console.log(`\n${"—".repeat(50)}`);
      console.log(`[eval] ${req.label}: "${req.conversation[0].content}"`);

      // ---- PLAN ----
      const planResult = await plan(site, req.conversation, env!.chat, env!.model);
      console.log(`[eval] plan result:`, JSON.stringify(planResult, null, 2));

      // Must produce a plan result (either ops or questions — not throw).
      expect(planResult).toBeDefined();
      expect(typeof planResult.needsInfo).toBe("boolean");

      if (planResult.needsInfo) {
        console.log(`[eval] model asked for clarification: ${JSON.stringify(planResult.questions)}`);
        console.log(`[eval] RESULT: needsInfo=true — no ops produced`);
        return; // Not a failure — just an ambiguous request.
      }

      console.log(`[eval] ops: ${JSON.stringify(planResult.ops)}`);
      console.log(`[eval] summary: ${planResult.summary}`);
      expect(planResult.ops).toBeDefined();
      expect((planResult.ops?.length ?? 0)).toBeGreaterThan(0);

      // ---- APPLY ----
      const applyResult = await apply(site, planResult.ops!, {
        browser,
        chat: env!.chat,
        model: env!.model,
        width: 1440,
        maxRetries: 1,
      });

      console.log(`[eval] apply ok=${applyResult.ok} reverted=${applyResult.reverted ?? false}`);
      if (applyResult.verifierReport.failures.length > 0) {
        console.log(`[eval] verifier failures: ${applyResult.verifierReport.failures.join("; ")}`);
      } else {
        console.log(`[eval] verifier: CLEAN`);
      }

      // Revert to baseline for next request.
      if (!applyResult.reverted) revert(site);

      // Lenient gate: we log failures but only assert plan produced ops (the LLM quality bar).
      // apply() result is the honest eval data.
    }, 300_000);
  }
});
