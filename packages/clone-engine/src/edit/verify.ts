/**
 * verify.ts — the per-section internal-fidelity VERIFIER (subsystem C, Task 3).
 *
 * This is the safety mechanism the whole edit subsystem rests on. An edit "looks right"
 * is not proof; this proves an edit landed as intended AND nothing else broke, and it is
 * designed to be FALSIFIABLE — a corrupting edit MUST make it fail.
 *
 * Given a BEFORE snapshot (the pre-edit shipped render) and the AFTER site (already edited),
 * we render AFTER and compare per section, keyed by data-component:
 *
 *   UNTOUCHED sections (not in the intent's edited set): crop each by its OWN bounding box in
 *     before and after and pixel-diff the two crops → must be 0-px. Because each crop is the
 *     section's own box, a section that merely reflowed/shifted down renders its own box and
 *     still verifies clean (POSITION-INDEPENDENT). This is what makes reflow safe.
 *
 *   EDITED section(s): an op-specific intended-change check —
 *     editCopy   → the section changed AND the change is bounded (something was allowed to move).
 *     setBrand   → every changed pixel tracks the recolor DELTA-VECTOR (ported from
 *                  verify-scoped.mjs); non-brand collateral must be ~0. (Brand is global, so we
 *                  check the recolor scope across the whole page, not one section box.)
 *     swapAsset  → the target section(s) changed (the image region); untouched sections clean.
 *     styleTweak → the target section changed AND all other sections clean.
 *
 *   STRUCTURAL: the section set after == the expected set given the intent (removed gone, added
 *     present, order correct) per site.json + the rendered DOM. Fail if not.
 *
 *   RENDER-SANITY: the page built + rendered; no section bounding boxes overlap beyond tolerance.
 *
 * failures[] are actionable human-readable strings; the apply-loop feeds them back to the LLM
 * for self-correction, e.g. "section 'StoriesOfGlorySection' changed 342px outside the edited target".
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import type { SiteRef, EditOp, VerifierReport, SectionDiff } from "./types.ts";
import type { BrandDoc } from "../types.ts";
import { renderSnapshot, sectionListOf, type RenderSnapshot } from "./snapshot.ts";
import { pixelDiff } from "../pixel.ts";

/** The edit's declared intent: which sections it meant to touch, and the op that did it. */
export interface EditIntent {
  /** data-component names (or section roles) the edit was allowed to change. */
  editedSections: string[];
  op: EditOp;
  /** setBrand only: the before/after hex of the recolored slot (drives the delta-vector scope). */
  brandRecolor?: { oldHex: string; newHex: string };
}

const OVERLAP_TOLERANCE_PX = 2; // sections may share a 1-2px seam (border collapse / sub-pixel).

/** Diff two same-section crops (before vs after) → differing-pixel count. 0 == internally clean. */
async function cropDiffPx(browser: Browser, aPng: Buffer, bPng: Buffer): Promise<number> {
  const r = await pixelDiff(browser, aPng, bPng);
  return r.d;
}

/**
 * Delta-vector recolor classifier (ported from experiments/edit-slice/verify-scoped.mjs).
 * Counts changed pixels split into inScope (track the recolor vector — allowed) vs outScope
 * (changed for an unrelated reason — collateral, the danger number). A clean recolor has
 * outScope === 0 and inScope > 0.
 */
async function classifyRecolor(
  browser: Browser,
  aPng: Buffer,
  bPng: Buffer,
  oldRgb: [number, number, number],
  newRgb: [number, number, number],
  tol = 24,
): Promise<{ changed: number; inScope: number; outScope: number }> {
  const dp = await browser.newPage();
  try {
    return await dp.evaluate(async ([aB64, bB64, params]) => {
      const pr = params as { oldRgb: number[]; newRgb: number[]; tol: number };
      const load = (s: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error("decode failed"));
          i.src = "data:image/png;base64," + s;
        });
      const [ia, ib] = await Promise.all([load(aB64 as string), load(bB64 as string)]);
      const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(ia, 0, 0); const A = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h); ctx.drawImage(ib, 0, 0); const B = ctx.getImageData(0, 0, w, h).data;

      const THRESH = 8;
      const near = (r: number, g: number, b: number, t: number[], tolr: number) =>
        Math.abs(r - t[0]) <= tolr && Math.abs(g - t[1]) <= tolr && Math.abs(b - t[2]) <= tolr;
      const dirR = Math.sign(pr.newRgb[0] - pr.oldRgb[0]);
      const dirG = Math.sign(pr.newRgb[1] - pr.oldRgb[1]);
      const dirB = Math.sign(pr.newRgb[2] - pr.oldRgb[2]);
      const MIN = 6;
      let changed = 0, inScope = 0, outScope = 0;
      for (let i = 0; i < A.length; i += 4) {
        const sr = B[i] - A[i], sg = B[i + 1] - A[i + 1], sb = B[i + 2] - A[i + 2];
        if (Math.abs(sr) <= THRESH && Math.abs(sg) <= THRESH && Math.abs(sb) <= THRESH) continue;
        changed++;
        const solid = near(A[i], A[i + 1], A[i + 2], pr.oldRgb, pr.tol) || near(B[i], B[i + 1], B[i + 2], pr.newRgb, pr.tol);
        const okR = dirR === 0 ? true : (dirR > 0 ? sr >= 0 : sr <= 0);
        const okG = dirG === 0 ? true : (dirG > 0 ? sg >= 0 : sg <= 0);
        const okB = dirB === 0 ? true : (dirB > 0 ? sb >= 0 : sb <= 0);
        const mag = (dirR !== 0 && Math.abs(sr) >= MIN) || (dirG !== 0 && Math.abs(sg) >= MIN) || (dirB !== 0 && Math.abs(sb) >= MIN);
        if (solid || (okR && okG && okB && mag)) inScope++; else outScope++;
      }
      return { changed, inScope, outScope };
    }, [aPng.toString("base64"), bPng.toString("base64"), { oldRgb, newRgb, tol }] as const);
  } finally {
    await dp.close();
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Resolve intent.editedSections (which may be roles or names) to the data-component NAMES present. */
function resolveEditedNames(intent: EditIntent, snapshotNames: Set<string>, list: Array<{ name: string; role: string }>): Set<string> {
  const roleToNames = new Map<string, string[]>();
  for (const s of list) {
    if (!roleToNames.has(s.role)) roleToNames.set(s.role, []);
    roleToNames.get(s.role)!.push(s.name);
  }
  const out = new Set<string>();
  for (const t of intent.editedSections) {
    if (snapshotNames.has(t)) { out.add(t); continue; }        // already a component name
    const byRole = roleToNames.get(t);                          // else a section role
    if (byRole) for (const n of byRole) out.add(n);
  }
  return out;
}

/** Do two boxes overlap by more than tolerance on both axes? */
function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, tol: number): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > tol && oy > tol;
}

/**
 * Verify an edit: prove it landed as intended AND nothing else broke.
 *
 * @param browser  a launched Playwright browser (shared; the verifier never launches its own).
 * @param before   the RenderSnapshot captured BEFORE the edit (via renderSnapshot on the pre-edit site).
 * @param after    the SiteRef of the edited site (already mutated on disk).
 * @param intent   which sections the edit meant to touch + the op.
 */
export async function verify(
  browser: Browser,
  before: RenderSnapshot,
  after: SiteRef,
  intent: EditIntent,
  opts: { width?: number; assetsFallback?: string | null } = {},
): Promise<VerifierReport> {
  const failures: string[] = [];
  const width = opts.width ?? before.width;

  // Render the AFTER site (this also proves it builds; a build failure throws before here,
  // so we treat a caught build failure as renderSane=false).
  let afterSnap: RenderSnapshot;
  try {
    afterSnap = await renderSnapshot(browser, after, { width, assetsFallback: opts.assetsFallback });
  } catch (err) {
    return {
      pass: false,
      sections: [],
      structural: { expected: before.order, actual: [], ok: false },
      renderSane: false,
      failures: [`render failed: ${(err as Error).message}`],
    };
  }

  const afterList = sectionListOf(after);
  const afterNames = new Set(afterSnap.sections.keys());
  const beforeNames = new Set(before.sections.keys());
  const edited = resolveEditedNames(intent, new Set([...beforeNames, ...afterNames]), afterList);

  // ---- STRUCTURAL: expected section set given the intent ----
  // For removeSection the removed name should be gone; for addSection the clone should appear.
  // Otherwise the set is unchanged. We derive `expected` from before + the op, then compare to
  // both site.json (afterList) and the rendered DOM (afterSnap.order) — they must agree.
  const expectedOrder = expectedSectionOrder(before.order, intent);
  const actualOrder = afterSnap.order;
  const manifestOrder = afterList.map((s) => s.name);
  const structuralOk =
    sameSet(expectedOrder, actualOrder) && sameSet(actualOrder, manifestOrder) && sameOrder(expectedOrder, actualOrder);
  if (!structuralOk) {
    failures.push(
      `structural mismatch: expected sections [${expectedOrder.join(", ")}] but rendered [${actualOrder.join(", ")}]` +
        (sameSet(actualOrder, manifestOrder) ? "" : ` (site.json disagrees: [${manifestOrder.join(", ")}])`),
    );
  }

  // ---- RENDER-SANITY: no section boxes overlap beyond tolerance ----
  let renderSane = true;
  const boxes = [...afterSnap.sections.values()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i].box, boxes[j].box, OVERLAP_TOLERANCE_PX)) {
        renderSane = false;
        failures.push(`render-sanity: sections '${boxes[i].name}' and '${boxes[j].name}' overlap (layout broke)`);
      }
    }
  }

  // ---- PER-SECTION diffs ----
  const sections: SectionDiff[] = [];

  // setBrand is a GLOBAL recolor; do a single whole-page delta-vector classify instead of
  // per-section boxes (the recolor legitimately touches every section that uses the slot).
  const isBrand = intent.op.op === "setBrand";
  if (isBrand) {
    if (!intent.brandRecolor) {
      failures.push("setBrand verify requires brandRecolor { oldHex, newHex } in intent");
    } else {
      const oldRgb = hexToRgb(intent.brandRecolor.oldHex);
      const newRgb = hexToRgb(intent.brandRecolor.newHex);
      const cls = await classifyRecolor(browser, before.fullPng, afterSnap.fullPng, oldRgb, newRgb);
      sections.push({ section: "(brand)", changed: cls.changed > 0, inScopePx: cls.inScope, outScopePx: cls.outScope });
      if (cls.outScope > 0) {
        failures.push(`setBrand recolor changed ${cls.outScope}px that do not track the recolor delta-vector (collateral)`);
      }
      if (cls.inScope === 0) {
        failures.push(`setBrand recolor changed nothing along the delta-vector (the recolor did not land)`);
      }
    }
  } else {
    // editCopy / swapAsset / styleTweak: per-section box diffs.
    for (const name of beforeNames) {
      if (!afterNames.has(name)) continue; // removed section — accounted for structurally, no diff
      const b = before.sections.get(name)!;
      const a = afterSnap.sections.get(name)!;
      const px = await cropDiffPx(browser, b.cropPng, a.cropPng);
      const isEdited = edited.has(name);
      const diff: SectionDiff = {
        section: name,
        changed: px > 0,
        inScopePx: isEdited ? px : 0,
        outScopePx: isEdited ? 0 : px,
      };
      sections.push(diff);
      if (!isEdited && px > 0) {
        failures.push(`section '${name}' changed ${px}px outside the edited target`);
      }
    }
    // Every edited section that survives must actually have changed (the edit must LAND).
    for (const name of edited) {
      if (!afterNames.has(name)) continue;
      const d = sections.find((s) => s.section === name);
      if (d && !d.changed) {
        failures.push(`edited section '${name}' shows no change (the edit did not land)`);
      }
    }
  }

  const pass = failures.length === 0;
  return {
    pass,
    sections,
    structural: { expected: expectedOrder, actual: actualOrder, ok: structuralOk },
    renderSane,
    failures,
  };
}

/** The section order we EXPECT after applying the op to the before order. */
function expectedSectionOrder(beforeOrder: string[], intent: EditIntent): string[] {
  const op = intent.op;
  if (op.op === "removeSection") {
    // op.section may be a role; the edited set resolves it to names. Drop any edited name.
    return beforeOrder.filter((n) => !intent.editedSections.includes(n) && n !== op.section);
  }
  // editCopy/setBrand/swapAsset/styleTweak/addSection/reorder: order is unchanged by default
  // (addSection/reorder verification is out of this task's negative controls; the structural
  // check still compares to the rendered DOM so a divergence is caught).
  return beforeOrder;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}
function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** Read the current brand slot hex from a projected site (helper for callers building intent). */
export function currentBrandHex(site: SiteRef, slot: string): string {
  const brand = JSON.parse(fs.readFileSync(path.join(site.dir, "astro", "brand.json"), "utf8")) as BrandDoc;
  const colors = brand.colors as unknown as Record<string, { hex: string }>;
  const s = colors[slot];
  if (!s) throw new Error(`currentBrandHex: unknown slot ${slot}`);
  return s.hex;
}

/** Re-export for callers/tests. */
export type { RenderSnapshot } from "./snapshot.ts";
export { renderSnapshot } from "./snapshot.ts";
