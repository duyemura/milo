/**
 * gen-smoke.ts — OPTIONAL real-LLM smoke for subsystem E (bounded section generation).
 *
 * Projects the golden speakeasy fixture to a temp dir, then generates a cta-band section with a
 * REAL LLM filling the copy (schema-constrained). Prints the filled copy, the emitted .astro, and
 * the verifier verdict (pre-existing sections must stay 0-px). NOT a gated test — a manual sanity.
 *
 * Run:  cd packages/clone-engine && node --env-file=../../.env --experimental-strip-types \
 *         ../../page-clone-spike/gen-smoke.ts
 *   (requires OPENROUTER_API_KEY in .env)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const GOLDEN = path.join(REPO, "packages/clone-engine/test/golden/speakeasy");

// Absolute-path imports so this runs from anywhere without workspace symlink resolution
// (the @milo/* aliases only resolve inside packages/clone-engine's own node_modules).
const { chatCompletion } = await import(path.join(REPO, "packages/llm/src/index.ts"));
const { project } = await import(path.join(REPO, "packages/clone-engine/src/index.ts"));
const { generateSection } = await import(path.join(REPO, "packages/clone-engine/src/edit/generate.ts"));

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error("OPENROUTER_API_KEY required (node --env-file=../../.env ...)"); process.exit(1); }
  const llmConfig = {
    provider: "openrouter" as const,
    openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    openrouterApiKey: key,
  };
  const model = process.env.MILO_CAPABLE_MODEL ?? "anthropic/claude-sonnet-4-6";

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gen-smoke-"));
  console.log(`projecting golden → ${out}`);
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });

  const browser = await chromium.launch();
  try {
    const result = await generateSection(
      { dir: out },
      { role: "cta-band", goal: "convert", brief: "A closing CTA inviting visitors to book a free intro class at this boxing + strength gym." },
      (o) => chatCompletion(o, llmConfig),
      model,
      browser,
      { width: 1440 },
    );

    console.log(`\n=== verifier verdict: ${result.ok ? "PASS" : "FAIL"} (section ${result.sectionName}) ===`);
    if (!result.ok) console.log("failures:", result.verifierReport.failures.join("\n  "));
    const preExisting = result.verifierReport.sections.filter((s) => s.section !== result.sectionName);
    console.log(`pre-existing sections all 0-px: ${preExisting.every((s) => s.outScopePx === 0)}`);

    console.log(`\n=== emitted ${result.sectionName}.astro ===`);
    console.log(fs.readFileSync(path.join(out, `astro/src/components/${result.sectionName}.astro`), "utf8"));
  } finally {
    await browser.close();
  }
  console.log(`\n(temp dir left at ${out} for inspection)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
