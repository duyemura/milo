/**
 * eval-edit.ts — real-LLM evaluation of the plan + apply pipeline (C-T9).
 *
 * NOT a CI test. Run manually:
 *   node --env-file=../.env eval-edit.ts
 *
 * Requires LLM_PROVIDER, DEFAULT_LLM_MODEL, and the provider's API key in .env.
 * Uses the sp-home projected out dir (already present in page-clone-spike/).
 * Runs 3 NL edit requests through the full plan→apply pipeline and reports
 * honestly on what happened: ops produced, target validation, apply result.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../packages/clone-engine/src/project.ts";
import { plan } from "../packages/clone-engine/src/edit/plan.ts";
import { apply } from "../packages/clone-engine/src/edit/apply.ts";
import { snapshot, revert } from "../packages/clone-engine/src/edit/history.ts";
import { chromium } from "playwright";
import { chatCompletion } from "@milo/llm";
import type { LlmConfig, ChatFn } from "@milo/llm";
import type { SiteRef, ConversationTurn } from "../packages/clone-engine/src/edit/types.ts";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. Build a real ChatFn from env (mirrors configFromEnv in labels.ts)
// ---------------------------------------------------------------------------

function buildChatFromEnv(): { chat: ChatFn; model: string } | null {
  const provider = process.env.LLM_PROVIDER;
  if (provider !== "openrouter" && provider !== "ollama") {
    console.error("[eval-edit] LLM_PROVIDER must be 'openrouter' or 'ollama'. Got:", provider ?? "(unset)");
    return null;
  }
  const model = process.env.DEFAULT_LLM_MODEL;
  if (!model) {
    console.error("[eval-edit] DEFAULT_LLM_MODEL is not set.");
    return null;
  }
  const config: LlmConfig = {
    provider,
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaApiKey: process.env.OLLAMA_API_KEY,
  };
  const chat: ChatFn = (o) => chatCompletion(o, config);
  return { chat, model };
}

// ---------------------------------------------------------------------------
// 2. Prepare the site fixture — project speakeasy to a fresh temp dir
// ---------------------------------------------------------------------------

const GOLDEN = path.join(__dir, "..", "packages", "clone-engine", "test", "golden", "speakeasy");

async function prepareSite(): Promise<{ out: string; site: SiteRef }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "eval-edit-"));
  console.log(`[eval-edit] Projecting speakeasy → ${out}`);
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  const site: SiteRef = { dir: out };
  snapshot(site); // baseline snapshot so revert() can restore
  return { out, site };
}

// ---------------------------------------------------------------------------
// 3. Eval requests
// ---------------------------------------------------------------------------

const EVAL_REQUESTS: Array<{ label: string; conversation: ConversationTurn[] }> = [
  {
    label: "primary-color-blue",
    conversation: [
      { role: "user", content: "Make the primary brand color blue, use #0066ff." },
    ],
  },
  {
    label: "headline-copy",
    conversation: [
      { role: "user", content: "Change the main hero headline to something more energetic and motivational." },
    ],
  },
  {
    label: "remove-testimonials",
    conversation: [
      { role: "user", content: "Remove the testimonials or stories section from the page." },
    ],
  },
];

// ---------------------------------------------------------------------------
// 4. Main eval loop
// ---------------------------------------------------------------------------

const env = buildChatFromEnv();
if (!env) {
  console.error("[eval-edit] Cannot build real LLM chat. Check .env. Exiting.");
  process.exit(1);
}

const { chat, model } = env;
console.log(`[eval-edit] Using model: ${model}`);

const { out, site } = await prepareSite();
const WIDTH = 1440;

// Find Astro modules for the apply verifier.
function findAstroModules(): string | null {
  const repo = path.resolve(__dir, "..");
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(__dir, "out-project-page/astro/node_modules"),
    path.join(repo, "packages/clone-engine/node_modules"),
    path.join(repo, "node_modules"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}
const astroModules = findAstroModules();
if (astroModules) process.env.ASTRO_MODULES = astroModules;

const browser = await chromium.launch();
const results: Array<{
  label: string;
  planResult: unknown;
  applyResult: unknown;
  error?: string;
}> = [];

for (const req of EVAL_REQUESTS) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[eval-edit] Request: ${req.label}`);
  console.log(`  NL: "${req.conversation[0].content}"`);

  try {
    // Plan.
    const planResult = await plan(site, req.conversation, chat, model);
    console.log("[eval-edit] Plan result:", JSON.stringify(planResult, null, 2));

    if (planResult.needsInfo) {
      console.log("[eval-edit] Model asked for clarification (needsInfo=true). Ops: none.");
      results.push({ label: req.label, planResult, applyResult: null });
      continue;
    }

    // Apply.
    console.log(`[eval-edit] Applying ${planResult.ops!.length} op(s)...`);
    const applyResult = await apply(site, planResult.ops!, {
      browser,
      chat, // real LLM for self-correction if needed
      model,
      width: WIDTH,
      maxRetries: 1,
    });
    console.log("[eval-edit] Apply result:", {
      ok: applyResult.ok,
      reverted: applyResult.reverted,
      opsApplied: applyResult.opsApplied,
      failures: applyResult.verifierReport.failures,
    });
    results.push({ label: req.label, planResult, applyResult });

    // Revert so each request starts from a clean state.
    if (!applyResult.reverted) {
      console.log("[eval-edit] Reverting to baseline for next request...");
      revert(site);
    }
  } catch (err) {
    console.error("[eval-edit] ERROR:", (err as Error).message);
    results.push({ label: req.label, planResult: null, applyResult: null, error: (err as Error).message });
    // Attempt revert to clean up partial state.
    try { revert(site); } catch { /* ignore */ }
  }
}

await browser.close();
fs.rmSync(out, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// 5. Summary report
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log("[eval-edit] SUMMARY REPORT");
console.log(`${"=".repeat(60)}`);
for (const r of results) {
  const plan = r.planResult as { needsInfo: boolean; ops?: unknown[]; questions?: string[]; summary?: string } | null;
  const applyR = r.applyResult as { ok: boolean; reverted?: boolean; verifierReport: { failures: string[] } } | null;
  console.log(`\nRequest: ${r.label}`);
  if (r.error) {
    console.log(`  ERROR: ${r.error}`);
    continue;
  }
  if (!plan) {
    console.log("  Plan: (no result)");
    continue;
  }
  if (plan.needsInfo) {
    console.log(`  Plan: needsInfo=true, questions: ${JSON.stringify(plan.questions)}`);
    console.log("  Apply: skipped (model asked for clarification)");
    continue;
  }
  console.log(`  Plan: needsInfo=false, ops: ${JSON.stringify(plan.ops)}, summary: "${plan.summary}"`);
  if (!applyR) {
    console.log("  Apply: (no result)");
    continue;
  }
  console.log(`  Apply: ok=${applyR.ok}, reverted=${applyR.reverted ?? false}`);
  if (applyR.verifierReport.failures.length > 0) {
    console.log(`  Verifier failures: ${applyR.verifierReport.failures.join("; ")}`);
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log("[eval-edit] DONE");
