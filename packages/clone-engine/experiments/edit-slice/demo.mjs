/**
 * demo.mjs — the payoff experiment for the EDIT BET (subsystem C, vertical slice).
 *
 * Projects the speakeasy golden into an editable Astro project, then runs TWO natural-language
 * edits end to end THROUGH the semantic contract, and — critically — proves each edit is SAFE
 * with a scoped pixel diff of the real astro build (edited region changed; nothing else moved).
 *
 *   Edit 1 (copy):  "Change the hero headline to 'Serious Strength, Ridiculous Fun'"
 *   Edit 2 (brand): "Make the primary brand color a deep blue (#1e40af)"
 *
 * Local only. NEVER deploys. Before/after full-page screenshots land in ./out/.
 *
 * Run: node experiments/edit-slice/demo.mjs   (from packages/clone-engine)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../src/project.ts";
import { nlEdit } from "./nl-edit.mjs";
import { readSite, findCopy } from "./edit-ops.mjs";
import { snapshotBefore, verifyScoped } from "./verify-scoped.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "../..");
const GOLDEN = path.join(PKG, "test/golden/speakeasy");
const OUT_SHOTS = path.join(HERE, "out");

const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(78));

/** Selector for the element that renders a given copy key (data-copy is space-separated). */
function copySelector(key) {
  return `[data-copy~="${key}"]`;
}

async function main() {
  fs.mkdirSync(OUT_SHOTS, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-slice-demo-"));

  rule();
  line("EDIT-SLICE DEMO — natural-language edits through the semantic contract");
  line(`project dir: ${outDir}`);
  rule();

  // 0. Project speakeasy → editable astro project + site.json + brand.json.
  line("\n[0] Projecting speakeasy golden → editable Astro project…");
  await project({ dir: GOLDEN, out: outDir, trim: true, noDiff: true });
  line("    ✓ projected (site.json + astro/brand.json + components)");

  const results = { edit1: null, edit2: null };

  // ── EDIT 1: copy ────────────────────────────────────────────────────────
  rule();
  const req1 = "Change the hero headline to 'Serious Strength, Ridiculous Fun'";
  line(`\n[1] NL request: ${req1}`);
  line("    Building BEFORE snapshot (clean projection)…");
  const before1 = snapshotBefore(outDir);

  const r1 = await nlEdit(outDir, req1);
  line(`    LLM chose op=${r1.plan.op}${r1.usedFallback ? " (FALLBACK)" : ""}`);
  line(`    target copyKey=${r1.plan.copyKey}  role=${findCopy(readSite(outDir), r1.plan.copyKey)?.role ?? "—"}`);
  line(`    before text: ${JSON.stringify(r1.applied.before)}`);
  line(`    after  text: ${JSON.stringify(r1.applied.after)}`);
  if (r1.plan.op !== "editCopy") throw new Error("Edit 1 expected editCopy");

  line("    Verifying (scoped diff of real astro build, before vs after)…");
  const v1 = await verifyScoped(outDir, before1, "editCopy", {
    selector: copySelector(r1.plan.copyKey),
    width: 1440,
    saveDir: OUT_SHOTS,
    label: "edit1-copy",
  });
  line(`    scoped-diff @${v1.width}w:`);
  line(`      changed pixels total     : ${v1.element.changed}`);
  line(`      ELEMENT-box scope (h1)   : in=${v1.element.inScope}  out=${v1.element.outScope}` +
       `  box y[${v1.elementBox.y0}..${v1.elementBox.y1}]`);
  if (v1.section) {
    line(`      SECTION-box scope (unit) : in=${v1.section.inScope}  out=${v1.section.outScope}` +
         `  box y[${v1.sectionBox.y0}..${v1.sectionBox.y1}]  ← site.json's edit unit`);
  }
  line(`      OUTSIDE the edit unit    : ${v1.outScope}  ← must be 0 for "nothing else moved"`);
  line(`    verdict: ${v1.safe ? "✓ SAFE" : "✗ UNSAFE"} · intended-change=${v1.intended ? "yes" : "NO"}`);
  results.edit1 = { req: req1, plan: r1.plan, applied: r1.applied, usedFallback: r1.usedFallback, verify: v1 };

  // ── EDIT 2: brand ───────────────────────────────────────────────────────
  rule();
  const req2 = "Make the primary brand color a deep blue (#1e40af)";
  line(`\n[2] NL request: ${req2}`);
  line("    Building BEFORE snapshot (state after edit 1)…");
  const before2 = snapshotBefore(outDir);

  const r2 = await nlEdit(outDir, req2);
  line(`    LLM chose op=${r2.plan.op}${r2.usedFallback ? " (FALLBACK)" : ""}`);
  line(`    target slot=${r2.plan.slot}  value=${r2.plan.value}`);
  line(`    before value: ${r2.applied.beforeValue}   (old hex ${r2.applied.oldHex})`);
  line(`    after  value: ${r2.applied.afterValue}`);
  if (r2.plan.op !== "setBrand") throw new Error("Edit 2 expected setBrand");

  line("    Verifying (recolor-scoped diff of real astro build)…");
  const v2 = await verifyScoped(outDir, before2, "setBrand", {
    oldHex: r2.applied.oldHex,
    newHex: r2.applied.hex,
    width: 1440,
    saveDir: OUT_SHOTS,
    label: "edit2-brand",
  });
  line(`    scoped-diff @${v2.width}w:`);
  line(`      changed pixels total : ${v2.changed}`);
  line(`      recolor pixels       : ${v2.inScope}  (were old primary → now new blue)`);
  line(`      NON-recolor changed  : ${v2.outScope}  ← must be ~0 (non-brand areas untouched)`);
  line(`    verdict: ${v2.safe ? "✓ SAFE" : "✗ UNSAFE"} · recolored=${v2.intended ? "yes" : "NO"}`);
  results.edit2 = { req: req2, plan: r2.plan, applied: r2.applied, usedFallback: r2.usedFallback, verify: v2 };

  // ── Report ────────────────────────────────────────────────────────────────
  rule();
  line("\nSUMMARY");
  line(`  Edit 1 (copy):  ${results.edit1.verify.safe && results.edit1.verify.intended ? "PASS" : "FAIL"}  ` +
       `(${results.edit1.verify.inScope} px changed in region, ${results.edit1.verify.outScope} px outside)`);
  line(`  Edit 2 (brand): ${results.edit2.verify.safe && results.edit2.verify.intended ? "PASS" : "FAIL"}  ` +
       `(${results.edit2.verify.inScope} recolor px, ${results.edit2.verify.outScope} collateral px)`);
  line(`  screenshots: ${OUT_SHOTS}/{edit1-copy,edit2-brand}-{before,after}.png`);
  rule();

  fs.writeFileSync(path.join(OUT_SHOTS, "result.json"), JSON.stringify(results, null, 2));
  line(`  machine result: ${path.join(OUT_SHOTS, "result.json")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
