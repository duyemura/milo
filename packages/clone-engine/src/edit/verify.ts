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
import type { SiteRef, VerifierReport, SectionDiff, EditIntent } from "./types.ts";
import type { BrandDoc, BrandColorSlot } from "../types.ts";
import { renderSnapshot, sectionListOf, type RenderSnapshot } from "./snapshot.ts";
import { pixelDiff } from "../pixel.ts";

// EditIntent now lives in ./types.ts (shared by apply.ts + generate.ts). Re-exported below.
export type { EditIntent } from "./types.ts";

export const OVERLAP_TOLERANCE_PX = 2; // sections may share a 1-2px seam (border collapse / sub-pixel).

/**
 * Diff two same-section crops (before vs after) → { px, dimChanged }. 0 px == internally clean.
 *
 * CRITICAL: pixelDiff only compares the top-left overlap rectangle (w=min widths, h=min heights),
 * so a corruption that changes a section's OWN crop dimensions (content injection, text reflow,
 * a font-size/padding bump that grows the box) would diff clean on the shared band and silently
 * PASS. A dimension change of a section's own box IS an internal change, so we hard-fail it: we
 * report the full crop area as changed pixels so it routes through the out-of-scope fail path.
 */
export async function cropDiffPx(browser: Browser, aPng: Buffer, bPng: Buffer): Promise<{ px: number; dimChanged: boolean }> {
  const r = await pixelDiff(browser, aPng, bPng);
  if (!r.dimMatch) return { px: Math.max(r.total, 1), dimChanged: true }; // dim change = guaranteed internal change
  return { px: r.d, dimChanged: false };
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

/**
 * Element-box sub-scope classifier (mode:"box" from verify-scoped.mjs), applied INSIDE a section
 * crop. Both crops are the section's own box; `relBox` is the edited element's box expressed
 * relative to the section-crop origin (with a small pad to absorb anti-aliasing at the edge).
 * A changed pixel INSIDE relBox is intended (inScope); one OUTSIDE is intra-section collateral
 * (outScope, a hard fail — the edit landed but broke the rest of the section's layout).
 */
async function classifyBoxInCrop(
  browser: Browser,
  aCrop: Buffer,
  bCrop: Buffer,
  relBox: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ changed: number; inScope: number; outScope: number }> {
  const dp = await browser.newPage();
  try {
    return await dp.evaluate(async ([aB64, bB64, box]) => {
      const b = box as { x0: number; y0: number; x1: number; y1: number };
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
      let changed = 0, inScope = 0, outScope = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (Math.abs(B[i] - A[i]) <= THRESH && Math.abs(B[i + 1] - A[i + 1]) <= THRESH && Math.abs(B[i + 2] - A[i + 2]) <= THRESH) continue;
          changed++;
          const inside = x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;
          if (inside) inScope++; else outScope++;
        }
      }
      return { changed, inScope, outScope };
    }, [aCrop.toString("base64"), bCrop.toString("base64"), relBox] as const);
  } finally {
    await dp.close();
  }
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
export function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, tol: number): boolean {
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
  // so we treat a caught build failure as renderSane=false). Also measure the edited element's
  // box when an elementSelector was provided (for the intra-section collateral sub-scope).
  const extraSelectors = intent.elementSelector ? [intent.elementSelector] : [];
  let afterSnap: RenderSnapshot;
  try {
    afterSnap = await renderSnapshot(browser, after, { width, assetsFallback: opts.assetsFallback, extraSelectors });
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

  // ---- SETTLE diagnostic: surface a non-settled render so the apply-loop can tell a flaky
  // render apart from a real diff (a non-settled AFTER frame can produce spurious out-of-scope px).
  if (!afterSnap.settled) {
    failures.push(
      "render did not settle: the AFTER page never produced two byte-identical frames within the retry budget — " +
        "any pixel diff below may be render flake, not a real change; re-run before trusting a fail",
    );
  }

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
  } else if (intent.op.op === "reorderSection") {
    // REORDER: a pure position change — all sections in the affected range may or may not show
    // pixel differences depending on sub-pixel Y rendering. The correctness guarantee is the
    // STRUCTURAL check (expectedSectionOrder), not pixel counts. For sections declared as edited
    // (the reordered range) we report inScopePx=px and never fail on "no change" — it's fine
    // for a section to look identical after a position-only move. Sections NOT in the edited set
    // are truly untouched and must still report 0-px (collateral guard).
    const elBoxDoc = null; // reorder has no element-level scope
    for (const name of beforeNames) {
      if (!afterNames.has(name)) continue;
      const b = before.sections.get(name)!;
      const a = afterSnap.sections.get(name)!;
      const { px, dimChanged } = await cropDiffPx(browser, b.cropPng, a.cropPng);
      const isEdited = edited.has(name);

      if (!isEdited) {
        // UNTOUCHED section (outside the reorder range): any change is out-of-scope collateral.
        sections.push({ section: name, changed: px > 0, inScopePx: 0, outScopePx: px });
        if (px > 0) {
          failures.push(
            `section '${name}' changed ${px}px outside the edited target` +
              (dimChanged ? " (changed dimensions — content/layout of an untouched section shifted)" : ""),
          );
        }
      } else {
        // POSITION-SHIFTED section: px may be 0 (looks identical) or >0 (sub-pixel Y rendering
        // changed). Both are valid — no "must show a change" requirement for a position-only op.
        sections.push({ section: name, changed: px > 0, inScopePx: px, outScopePx: 0 });
      }
    }
  } else {
    // editCopy / swapAsset / styleTweak / removeSection (surviving sections): per-section box diffs.
    // The edited element's box relative to its section crop (for the intra-section sub-scope).
    const elBoxDoc = intent.elementSelector ? afterSnap.extraBoxes.get(intent.elementSelector) ?? null : null;
    for (const name of beforeNames) {
      if (!afterNames.has(name)) continue; // removed section — accounted for structurally, no diff
      const b = before.sections.get(name)!;
      const a = afterSnap.sections.get(name)!;
      const { px, dimChanged } = await cropDiffPx(browser, b.cropPng, a.cropPng);
      const isEdited = edited.has(name);

      if (!isEdited) {
        // UNTOUCHED section: any internal change (including a dimension change) is out-of-scope.
        sections.push({ section: name, changed: px > 0, inScopePx: 0, outScopePx: px });
        if (px > 0) {
          failures.push(
            `section '${name}' changed ${px}px outside the edited target` +
              (dimChanged ? " (changed dimensions — content/layout of an untouched section shifted)" : ""),
          );
        }
        continue;
      }

      // EDITED section. A dimension change of the section itself is expected for some edits (a copy
      // change can reflow the section taller), so a dim change here is treated as in-scope. Within
      // the section, if we know the edited element's box, sub-scope to it: pixels inside the element
      // box are intended; pixels outside are intra-section collateral (a hard fail).
      if (elBoxDoc && !dimChanged) {
        const PAD = 4;
        const rel = {
          x0: Math.max(0, Math.floor(elBoxDoc.x - a.box.x) - PAD),
          y0: Math.max(0, Math.floor(elBoxDoc.y - a.box.y) - PAD),
          x1: Math.ceil(elBoxDoc.x - a.box.x + elBoxDoc.w) + PAD,
          y1: Math.ceil(elBoxDoc.y - a.box.y + elBoxDoc.h) + PAD,
        };
        const cls = await classifyBoxInCrop(browser, b.cropPng, a.cropPng, rel);
        sections.push({ section: name, changed: cls.changed > 0, inScopePx: cls.inScope, outScopePx: cls.outScope });
        if (cls.outScope > 0) {
          failures.push(
            `edited section '${name}' changed ${cls.outScope}px OUTSIDE the edited element box (intra-section collateral — the edit broke the rest of the section)`,
          );
        }
        if (cls.inScope === 0) {
          failures.push(`edited section '${name}' shows no change inside the edited element box (the edit did not land)`);
        }
      } else {
        // No element selector (or the section's own dimensions changed): trust at section granularity.
        sections.push({ section: name, changed: px > 0, inScopePx: px, outScopePx: 0 });
        if (px === 0) {
          failures.push(`edited section '${name}' shows no change (the edit did not land)`);
        }
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
  // Caller-declared order takes precedence — the op is the authority, the verifier is the witness.
  // This is REQUIRED for reorderSection (without it the structural check would false-fail every
  // reorder). Also correct for any op that needs to express the exact post-edit order.
  if (intent.expectedSectionOrder) return intent.expectedSectionOrder;

  const op = intent.op;
  if (op.op === "removeSection") {
    // op.section may be a role; the edited set resolves it to names. Drop any edited name.
    return beforeOrder.filter((n) => !intent.editedSections.includes(n) && n !== op.section);
  }
  if (op.op === "reorderSection" || op.op === "addSection") {
    // These ops change section order/membership — the caller MUST declare the intended
    // post-edit order via intent.expectedSectionOrder (returned above). Without it the
    // structural check would silently false-fail, so fail loudly instead of guessing.
    throw new Error(
      `verify: ${op.op} requires intent.expectedSectionOrder (the intended post-edit section order)`,
    );
  }
  // editCopy/setBrand/swapAsset/styleTweak: order is unchanged by default
  // (the structural check still compares to the rendered DOM so a divergence is caught).
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
  const entry = (Object.entries(brand.colors) as Array<[keyof BrandDoc["colors"], BrandColorSlot]>)
    .find(([name]) => name === slot);
  if (!entry) throw new Error(`currentBrandHex: unknown slot ${slot}`);
  return entry[1].hex;
}

/** Re-export for callers/tests. */
export type { RenderSnapshot } from "./snapshot.ts";
export { renderSnapshot } from "./snapshot.ts";
