/**
 * apply.test.ts — the self-correcting edit loop (subsystem C, T8).
 *
 * The headline guarantee: apply NEVER ships a broken edit. On any non-passing outcome the
 * site is restored BYTE-IDENTICAL to its pre-apply state.
 *
 * The LLM is ALWAYS mocked via a local fakeChat (no real API). The verifier is REAL — each
 * test projects speakeasy to its own fresh temp dir, builds the real Astro artifact, and
 * runs the real per-section pixel verifier over a shared browser. Run ALONE to avoid browser
 * contention flakes (`vitest run test/edit/apply.test.ts`).
 *
 * Tests:
 *   1. Clean op → PASS, no revise call. (fakeChat never invoked.)
 *   2. Fails once, revision fixes it → PASS after 1 retry, opsApplied === the revised ops.
 *      Seam: a no-op editCopy (text == current) genuinely fails the verifier ("edit did not
 *      land"); the revised op changes the text and passes. A real fail→pass, no mocked verify.
 *   3. Keeps failing → REVERT. fakeChat returns non-fixing (still no-op) revisions → after
 *      maxRetries, ok:false + reverted:true AND the editable files are byte-identical to before.
 *   4. Intent constraint: a revision that retargets to a DIFFERENT copy key is REJECTED (never
 *      applied) — reviseOps returns null and the smuggled edit does not touch the site.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../src/project.ts";
import { apply, reviseOps } from "../../src/edit/apply.ts";
import type { SiteRef, EditOp } from "../../src/edit/types.ts";
import type { SiteManifest } from "../../src/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN = path.join(dir, "../golden/speakeasy");
const WIDTH = 1440;
const MODEL = "test-model";

/** A shared astro@^4 node_modules must exist to build the artifact; else the suite skips. */
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

/**
 * A fakeChat that records how many times it was invoked and returns scripted JSON responses in
 * order (the last response repeats). `calls` lets a test assert the revise LLM was / wasn't hit.
 */
function fakeChat(responses: string[]): ChatFn & { calls: number } {
  let i = 0;
  const fn = Object.assign(
    async (): Promise<ChatResponse> => {
      (fn as { calls: number }).calls++;
      return { content: responses[Math.min(i++, responses.length - 1)] };
    },
    { calls: 0 },
  );
  return fn;
}

/** Project speakeasy to a fresh temp dir. Each mutating test owns its own copy. */
async function projectFixture(): Promise<{ out: string; site: SiteRef; manifest: SiteManifest }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "edit-apply-"));
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  const site: SiteRef = { dir: out };
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
  return { out, site, manifest };
}

/** The current text at a copy key (used to build a genuinely no-op editCopy). */
function currentCopyText(manifest: SiteManifest, key: string): string {
  for (const page of manifest.pages) {
    const c = page.copy.find((e) => e.key === key);
    if (c) return c.text;
  }
  throw new Error(`copy key not in fixture: ${key}`);
}

/**
 * A stable content hash of every editable file under the site — the byte-identical rollback
 * oracle. We hash file paths + contents across all subtrees ops.ts can mutate (mirrors the set
 * history.ts snapshots). Two runs with the same hash === the site is byte-identical.
 */
function editableHash(siteDir: string): string {
  const files: string[] = [];
  const walk = (abs: string, rel: string) => {
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const c of fs.readdirSync(abs).sort()) walk(path.join(abs, c), path.join(rel, c));
    } else {
      files.push(rel);
    }
  };
  const push = (rel: string) => walk(path.join(siteDir, rel), rel);
  push("site.json");
  push(path.join("astro", "brand.json"));
  push(path.join("astro", "src"));
  push(path.join("astro", "public", "assets"));
  push("assets");

  const h = crypto.createHash("sha256");
  for (const rel of files.sort()) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(siteDir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { if (browser) await browser.close(); });

const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("apply — self-correcting edit loop", () => {
  // 1. CLEAN op → PASS, no revise LLM call.
  it("clean op passes with no retry and never calls the revise LLM", async () => {
    const { out, site } = await projectFixture();
    cleanup.add(out);

    const ops: EditOp[] = [{ op: "editCopy", copyKey: "S3StepsToSection.6", text: "Edited step" }];
    const chat = fakeChat(["{}"]); // would blow up validation if ever called for a revise

    const result = await apply(site, ops, { browser, chat, model: MODEL, width: WIDTH });

    expect(result.ok, `expected pass, failures: ${result.verifierReport.failures.join(" | ")}`).toBe(true);
    expect(result.reverted).toBeUndefined();
    expect(result.opsApplied).toEqual(ops);
    // The verifier passed on attempt 0 → the revise LLM was never invoked.
    expect(chat.calls, "clean edit must not call the revise LLM").toBe(0);
  }, 300_000);

  // 2. FAILS once, revision fixes it → PASS after 1 retry.
  it("fails once then a revision fixes it: passes with opsApplied === the revised ops", async () => {
    const { out, site, manifest } = await projectFixture();
    cleanup.add(out);

    const KEY = "S3StepsToSection.6";
    const currentText = currentCopyText(manifest, KEY);

    // The FIRST op is a no-op (text == current) → the verifier fails: "the edit did not land".
    const ops: EditOp[] = [{ op: "editCopy", copyKey: KEY, text: currentText }];

    // The revision changes the text → the edit lands → verifier passes.
    const revised = { ops: [{ op: "editCopy", copyKey: KEY, text: "Edited step" }] };
    const chat = fakeChat([JSON.stringify(revised)]);

    const result = await apply(site, ops, { browser, chat, model: MODEL, width: WIDTH, maxRetries: 2 });

    expect(result.ok, `expected pass after revision, failures: ${result.verifierReport.failures.join(" | ")}`).toBe(true);
    expect(result.reverted).toBeUndefined();
    expect(result.opsApplied).toEqual(revised.ops);
    expect(chat.calls, "exactly one revise LLM call").toBe(1);
    // The revised text is what actually landed on disk (editCopy rewrites the component's
    // content[] array; site.json copy[].text is a build-time cache and is not touched, so we
    // assert against the .astro component file the render is built from).
    const compFile = path.join(out, "astro", "src", "components", "S3StepsToSection.astro");
    expect(fs.readFileSync(compFile, "utf8")).toContain("Edited step");
  }, 300_000);

  // 3. HEADLINE — keeps failing → REVERT, and the site is byte-identical to pre-apply.
  it("exhausts retries then reverts byte-identically (never ships broken)", async () => {
    const { out, site, manifest } = await projectFixture();
    cleanup.add(out);

    const KEY = "S3StepsToSection.6";
    const currentText = currentCopyText(manifest, KEY);

    // Byte-hash of the editable state BEFORE apply.
    const beforeHash = editableHash(out);

    // Both the original op AND every revision are no-ops (text == current) → always fails.
    const ops: EditOp[] = [{ op: "editCopy", copyKey: KEY, text: currentText }];
    const nonFixing = { ops: [{ op: "editCopy", copyKey: KEY, text: currentText }] };
    const chat = fakeChat([JSON.stringify(nonFixing)]);

    const result = await apply(site, ops, { browser, chat, model: MODEL, width: WIDTH, maxRetries: 2 });

    expect(result.ok, "a persistently-failing edit must NOT pass").toBe(false);
    expect(result.reverted, "an exhausted edit must be reverted").toBe(true);
    expect(result.opsApplied, "no ops are 'applied' on a reverted edit").toEqual([]);
    // Two revise attempts were made before giving up.
    expect(chat.calls, "maxRetries revise LLM calls before reverting").toBe(2);

    // HEADLINE ASSERTION: the site is byte-identical to its pre-apply state.
    const afterHash = editableHash(out);
    expect(afterHash, "reverted site must be BYTE-IDENTICAL to pre-apply").toBe(beforeHash);
  }, 300_000);

  // 4. INTENT CONSTRAINT — a revision that retargets to a DIFFERENT copy key is rejected,
  //    never applied. reviseOps returns null; apply treats it as a failed attempt.
  it("rejects a revision that changes the target (can't smuggle in an unrelated edit)", async () => {
    const { out, site, manifest } = await projectFixture();
    cleanup.add(out);

    const KEY = "S3StepsToSection.6";
    const OTHER = "S3StepsToSection.7"; // a DIFFERENT copy key in the same section
    const currentText = currentCopyText(manifest, KEY);
    // Ensure OTHER is a real, distinct key present in the fixture (guards the test's premise).
    expect(currentCopyText(manifest, OTHER)).toBeTypeOf("string");
    const beforeHash = editableHash(out);

    // Original: no-op on KEY (fails). Revision tries to retarget to OTHER — an unrelated edit.
    const ops: EditOp[] = [{ op: "editCopy", copyKey: KEY, text: currentText }];
    const smuggled = { ops: [{ op: "editCopy", copyKey: OTHER, text: "SMUGGLED EDIT" }] };
    const chat = fakeChat([JSON.stringify(smuggled)]);

    // Direct unit assertion: reviseOps rejects the retarget → null.
    const rev = await reviseOps(ops, ["the edit did not land"], { browser, chat, model: MODEL });
    expect(rev, "a retargeted revision must be rejected").toBeNull();

    // End-to-end: apply exhausts (every revision is rejected) → reverts byte-identically,
    // and the OTHER copy key was NEVER touched by the smuggled edit.
    const chat2 = fakeChat([JSON.stringify(smuggled)]);
    const result = await apply(site, ops, { browser, chat: chat2, model: MODEL, width: WIDTH, maxRetries: 2 });

    expect(result.ok).toBe(false);
    expect(result.reverted).toBe(true);
    // The smuggled edit (which would rewrite the component's content[]) must NEVER have landed.
    const compFile = path.join(out, "astro", "src", "components", "S3StepsToSection.astro");
    expect(fs.readFileSync(compFile, "utf8")).not.toContain("SMUGGLED EDIT");
    expect(editableHash(out), "site byte-identical after a rejected-revision revert").toBe(beforeHash);
  }, 300_000);
});
