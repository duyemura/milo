/**
 * apply.ts — the self-correcting edit loop (subsystem C, Task 8).
 *
 * `apply` is the one entry point that NEVER ships a broken edit. It:
 *   1. snapshots the site's editable state (history.ts) — the pre-edit rollback point,
 *   2. renders the BEFORE snapshot (snapshot.ts) for the verifier,
 *   3. applies the validated ops deterministically (ops.ts),
 *   4. verifies the result (verify.ts),
 *   5. if it fails, asks the LLM for a REVISED version of the SAME ops (same op-kinds,
 *      same targets — values only), rolls back to pre-edit, re-applies, re-verifies,
 *   6. after `maxRetries` exhausted, rolls back to pre-edit and returns { ok:false, reverted:true }.
 *
 * The load-bearing guarantee: on ANY non-passing outcome the site is restored
 * byte-identical to its pre-apply state. A broken edit is never left on disk.
 *
 * The revise step is intent-constrained: the LLM may only tweak op VALUES (a different
 * color, a corrected position, revised text) — it may not introduce a new op, change an
 * op's kind, or retarget it. Any revised op whose (kind, target) doesn't match one of the
 * originals is rejected and the attempt is treated as a failure.
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import { z } from "zod";
import type { SiteRef, EditOp, EditResult, OpResult, VerifierReport } from "./types.ts";
import { EditOpSchema } from "./types.ts";
import {
  editCopy,
  setBrand,
  swapAsset,
  styleTweak,
  removeSection,
  reorderSection,
  addSection,
  addPage,
} from "./ops.ts";
import { verify, type EditIntent } from "./verify.ts";
import { renderSnapshot, sectionListOf, type RenderSnapshot } from "./snapshot.ts";
import { snapshot, restore } from "./history.ts";
import { resolveElement, resolveSection } from "./target.ts";
import { llmJson } from "@milo/llm";
import type { ChatFn } from "@milo/llm";

export interface ApplyOptions {
  browser: Browser;
  chat: ChatFn;
  model: string;
  /** Verifier snapshot width (defaults to the before snapshot's width). */
  width?: number;
  /** Golden capture assets/ dir for the render fallback (defaults to the site's own). */
  assetsFallback?: string | null;
  /** How many LLM revision attempts to try before reverting. Default 2. */
  maxRetries?: number;
}

/** Structural ops change section membership/order, so the verifier needs an expectedSectionOrder. */
const STRUCTURAL_OPS = new Set<EditOp["op"]>(["removeSection", "reorderSection", "addSection"]);

/**
 * Apply a batch of ops with self-correction, never shipping a broken edit.
 *
 * @param site  the projected OUT dir to edit in place.
 * @param ops   the validated ops (from plan.ts). Must be non-empty.
 * @param opts  browser + LLM handles + retry budget.
 */
export async function apply(
  site: SiteRef,
  ops: EditOp[],
  opts: ApplyOptions,
): Promise<EditResult> {
  if (ops.length === 0) throw new Error("apply: ops must be non-empty");
  const maxRetries = opts.maxRetries ?? 2;

  // Pre-edit rollback point. Every failed attempt AND final exhaustion restores to this.
  const token = snapshot(site);

  // BEFORE render for the verifier — captured on the pristine, pre-edit site.
  const before = await renderSnapshot(opts.browser, site, {
    width: opts.width,
    assetsFallback: opts.assetsFallback,
  });

  // Capture brand hexes BEFORE any edit so a setBrand op can build its recolor delta-vector.
  const brandBefore = readBrandHexes(site);

  // --- Attempt 0: the ops as planned. ---
  let report = await applyAndVerify(site, ops, before, brandBefore, opts);
  if (report.pass) {
    return { ok: true, verifierReport: report, opsApplied: ops };
  }

  // --- Self-correction attempts. ---
  let currentOps = ops;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const revised = await reviseOps(currentOps, report.failures, opts);

    // Roll back to the pristine pre-edit state before trying the revision.
    restore(site, token);

    if (!revised) {
      // The LLM tried to smuggle in a target/op-kind change (or produced no valid revision):
      // reject and treat this as a failed attempt. Site is already rolled back.
      continue;
    }

    report = await applyAndVerify(site, revised, before, brandBefore, opts);
    if (report.pass) {
      return { ok: true, verifierReport: report, opsApplied: revised };
    }
    currentOps = revised;
  }

  // Exhausted — full rollback to pre-edit. NEVER ship a broken edit.
  restore(site, token);
  return { ok: false, verifierReport: report, opsApplied: [], reverted: true };
}

/**
 * Apply the ops deterministically, then build the intent and verify. Returns the verifier
 * report. ANY throw across the whole phase — op apply, intent build, or verify (including the
 * unwrapped diff phase where `browser.newPage()` could throw AFTER files were already mutated) —
 * is converted into a non-passing report. This is load-bearing for the "never ships broken"
 * invariant: a throw here must route through the caller's `restore`, not escape `apply()` and
 * leave a half-edited site on disk (there is no surrounding restore on attempt 0 or the final
 * retry). verify's own build/render failures already surface as renderSane=false, not throws;
 * this catch covers everything else.
 */
async function applyAndVerify(
  site: SiteRef,
  ops: EditOp[],
  before: RenderSnapshot,
  brandBefore: Record<string, string>,
  opts: ApplyOptions,
): Promise<VerifierReport> {
  try {
    const results = await applyOpsDeterministically(site, ops);
    const intent = buildIntent(site, ops, results, brandBefore);
    return await verify(opts.browser, before, site, intent, {
      width: opts.width ?? before.width,
      assetsFallback: opts.assetsFallback,
    });
  } catch (err) {
    // An op threw (a resolver rejected a revised value), or intent-build/verify threw after the
    // ops already mutated files. Surface as a non-passing report so the loop rolls back.
    return {
      pass: false,
      sections: [],
      structural: { expected: before.order, actual: [], ok: false },
      renderSane: false,
      failures: [`apply: edit phase threw: ${(err as Error).message}`],
    };
  }
}

/** Dispatch each op to its deterministic implementation, in order. */
async function applyOpsDeterministically(site: SiteRef, ops: EditOp[]): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "editCopy":
        results.push(editCopy(site, op.copyKey, op.text));
        break;
      case "setBrand":
        results.push(setBrand(site, op.slot, op.value));
        break;
      case "swapAsset":
        results.push(await swapAsset(site, op.alias, op.source));
        break;
      case "styleTweak":
        results.push(styleTweak(site, op.target, op.prop, op.value));
        break;
      case "removeSection":
        results.push(removeSection(site, op.section));
        break;
      case "reorderSection":
        results.push(reorderSection(site, op.section, op.toIndex));
        break;
      case "addSection":
        results.push(addSection(site, op.cloneOf, op.afterSection));
        break;
      case "addPage":
        results.push(addPage(site, op.route, op.cloneOfPage));
        break;
    }
  }
  return results;
}

/**
 * Form the verifier intent for a batch of ops.
 *
 * - `editedSections` = the UNION of every op's targetSections. This preserves the
 *   verifier's core guarantee (every UNTOUCHED section stays 0-px) for the whole batch.
 * - `op` (singular, per EditIntent) = ops[0]. For a single-op edit this is exact. For a
 *   batch it selects the op-specific edited-section check for ops[0]; the load-bearing
 *   safety property — nothing outside the union edited set changed, plus structural +
 *   render-sanity — holds regardless via editedSections.
 * - `expectedSectionOrder` is set whenever ANY op is structural (reorder/add/remove): the
 *   ops already mutated site.json, so the current section order IS the intended final order.
 *   verify() REQUIRES this for reorder/add and would otherwise throw.
 * - `elementSelector` is derived from ops[0]'s target element (via the manifest), for the
 *   intra-section collateral sub-scope — only for single element-targeted ops.
 * - `brandRecolor` is set for a setBrand ops[0] from the pre-edit hex + the op's new value.
 */
function buildIntent(
  site: SiteRef,
  ops: EditOp[],
  results: OpResult[],
  brandBefore: Record<string, string>,
): EditIntent {
  const editedSections = [...new Set(results.flatMap((r) => r.targetSections))];
  const primary = ops[0];

  const intent: EditIntent = { editedSections, op: primary };

  // Structural batch → the post-edit section order is the authority.
  if (ops.some((o) => STRUCTURAL_OPS.has(o.op))) {
    intent.expectedSectionOrder = currentSectionOrder(site);
  }

  // Element-targeted single ops: sub-scope to the edited element's box when resolvable.
  // Only meaningful for a single op (the primary) — a batch with mixed elements can't be
  // sub-scoped to one box, so we fall back to whole-section trust for those.
  if (ops.length === 1) {
    if (primary.op === "editCopy") {
      intent.elementSelector = `[data-copy~="${primary.copyKey}"]`;
    } else if (primary.op === "styleTweak") {
      const sel = elementSelectorForTarget(site, primary.target);
      if (sel) intent.elementSelector = sel;
    }
  }

  // setBrand primary → recolor delta-vector needs the pre-edit hex.
  if (primary.op === "setBrand") {
    const oldHex = brandBefore[primary.slot];
    if (oldHex) intent.brandRecolor = { oldHex, newHex: primary.value };
  }

  return intent;
}

/** The section order currently on disk (site.json) — used as the intended post-edit order. */
function currentSectionOrder(site: SiteRef): string[] {
  return sectionListOf(site).map((s) => s.name);
}

/**
 * Resolve a styleTweak target (element role OR section role/name) to a CSS selector for the
 * intra-section element sub-scope. Prefers an element-role selector; falls back to a
 * data-component selector for a section target. Returns null if nothing resolves.
 */
function elementSelectorForTarget(site: SiteRef, target: string): string | null {
  try {
    const { selector } = resolveElement(site, target);
    return selector;
  } catch {
    try {
      const { name } = resolveSection(site, target);
      return `[data-component="${name}"]`;
    } catch {
      return null;
    }
  }
}

/** Read the current hex of every brand slot from astro/brand.json (empty map if absent). */
function readBrandHexes(site: SiteRef): Record<string, string> {
  const brandPath = path.join(site.dir, "astro", "brand.json");
  if (!fs.existsSync(brandPath)) return {};
  const brand = JSON.parse(fs.readFileSync(brandPath, "utf8")) as {
    colors: Record<string, { hex: string }>;
  };
  const out: Record<string, string> = {};
  for (const [slot, obj] of Object.entries(brand.colors)) out[slot] = obj.hex;
  return out;
}

// ---------------------------------------------------------------------------
// reviseOps — intent-constrained self-correction
// ---------------------------------------------------------------------------

const REVISE_SYSTEM_PROMPT = `You are correcting a website edit that FAILED verification.

The following edit failed verification:
<failures>
{{FAILURES}}
</failures>

You will be given the ORIGINAL ops as JSON. Propose a REVISED version of THESE SAME ops
that fixes the problem. Hard rules:
- Keep the SAME op types, in the SAME order, targeting the SAME elements.
- You may ONLY change VALUES (e.g. a different color hex, a corrected position index,
  revised copy text). You may NOT add new ops, remove ops, change an op's type, or retarget it.
- Return the SAME number of ops.

Output valid JSON of the form { "ops": [ ... ] } matching the ops schema. No prose, no markdown.`;

const ReviseSchema = z.object({ ops: z.array(EditOpSchema).min(1) });

/**
 * Ask the LLM for a revised version of `ops`, constrained to the same op-kinds and the same
 * targets (values only). Returns the revised ops, or `null` if the LLM violated the constraint
 * (changed a target or op-kind, or the count) — a null result is treated by the caller as a
 * failed attempt (the smuggled edit is never applied).
 */
export async function reviseOps(
  ops: EditOp[],
  failures: string[],
  opts: ApplyOptions,
): Promise<EditOp[] | null> {
  const system = REVISE_SYSTEM_PROMPT.replace("{{FAILURES}}", failures.map((f) => `- ${f}`).join("\n"));

  let raw: { ops: EditOp[] };
  try {
    raw = await llmJson(ReviseSchema, {
      chat: opts.chat,
      model: opts.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Original ops:\n${JSON.stringify(ops, null, 2)}` },
      ],
      temperature: 0.2,
    });
  } catch {
    // The LLM never produced schema-valid ops within its own retry budget → failed attempt.
    return null;
  }

  const revised = raw.ops;

  // Constraint enforcement: same count, same op-kind + same target-identity, positionally.
  if (revised.length !== ops.length) return null;
  for (let i = 0; i < ops.length; i++) {
    if (revised[i].op !== ops[i].op) return null;
    if (targetIdentity(revised[i]) !== targetIdentity(ops[i])) return null;
  }
  return revised;
}

/**
 * A stable string identifying WHAT an op targets (independent of the VALUE it sets). Two ops
 * with the same op-kind and the same targetIdentity are "the same edit, different value" —
 * exactly what a revision is allowed to be. A differing identity means the LLM retargeted the
 * edit (a new, unrelated change), which the constraint rejects.
 */
function targetIdentity(op: EditOp): string {
  switch (op.op) {
    case "editCopy":
      return `editCopy:${op.copyKey}`;
    case "setBrand":
      return `setBrand:${op.slot}`;
    case "swapAsset":
      return `swapAsset:${op.alias}`;
    case "styleTweak":
      // target + prop identify the edited declaration; the VALUE is what a revision may change.
      return `styleTweak:${op.target}:${op.prop}`;
    case "removeSection":
      return `removeSection:${op.section}`;
    case "reorderSection":
      // The section being moved is the target; toIndex is the value a revision may change.
      return `reorderSection:${op.section}`;
    case "addSection":
      return `addSection:${op.cloneOf}`;
    case "addPage":
      return `addPage:${op.route}`;
  }
}

// Re-exported for direct testing of the intent + constraint seams.
export { buildIntent as buildIntentForTest, targetIdentity as targetIdentityForTest };
