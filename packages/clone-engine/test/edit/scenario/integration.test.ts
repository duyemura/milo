/**
 * integration.test.ts — end-to-end integration scenarios for subsystem C (C-T9).
 *
 * Drives the FULL pipeline for each scenario:
 *   plan (fakeChat → ops) → apply (real ops + real verifier, mocked chat) → assert
 *   {ok:true} + verifier clean → revert → assert byte-identical editable state
 *
 * Four scenario kinds:
 *   (a) editCopy    — copy edit on a real copy key
 *   (b) setBrand    — recolor primary to a new hex
 *   (c) removeSection — remove a real section
 *   (d) addPage     — add a new route cloned from a template page
 *
 * The LLM is ALWAYS mocked. The verifier is REAL. Browser is shared across all tests.
 * Run in isolation if browser contention flakes:
 *   pnpm vitest run test/edit/scenario/integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../../src/project.ts";
import { plan } from "../../../src/edit/plan.ts";
import { apply } from "../../../src/edit/apply.ts";
import { revert, snapshot } from "../../../src/edit/history.ts";
import type { SiteRef, EditOp, ConversationTurn } from "../../../src/edit/types.ts";
import type { SiteManifest } from "../../../src/types.ts";
import type { ChatFn, ChatResponse } from "@milo/llm";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");
const REPO = path.resolve(PKG, "../..");
const GOLDEN = path.join(dir, "../../golden/speakeasy");
const WIDTH = 1440;
const MODEL = "test-model";

// ---------------------------------------------------------------------------
// Shared infra — browser + Astro modules
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

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
  if (ASTRO_MODULES) process.env.ASTRO_MODULES = ASTRO_MODULES;
}, 60_000);
afterAll(async () => { if (browser) await browser.close(); });

const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Project speakeasy to a fresh temp dir and take an initial snapshot. */
async function projectFixture(): Promise<{ out: string; site: SiteRef; manifest: SiteManifest }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "edit-integration-"));
  cleanup.add(out);
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  const site: SiteRef = { dir: out };
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
  // Prime history: one snapshot so revert() has a rollback point.
  snapshot(site);
  return { out, site, manifest };
}

/**
 * A fakeChat for the PLANNER — returns a single scripted plan response.
 * Records call count so we can assert it was invoked exactly once.
 */
function fakePlanChat(planResponse: object): ChatFn & { calls: number } {
  const fn = Object.assign(
    async (): Promise<ChatResponse> => {
      (fn as { calls: number }).calls++;
      return { content: JSON.stringify(planResponse) };
    },
    { calls: 0 },
  );
  return fn;
}

/**
 * A fakeChat for the APPLY revise loop — returns scripted responses in order.
 * For all our passing scenarios the verifier passes on attempt 0, so this should
 * never be invoked. Return an invalid JSON body so any invocation fails loudly.
 */
function fakeApplyChat(): ChatFn & { calls: number } {
  const fn = Object.assign(
    async (): Promise<ChatResponse> => {
      (fn as { calls: number }).calls++;
      // Return invalid JSON — if the apply loop calls this, the test will fail.
      return { content: '{"broken":"apply-revise-chat-must-not-be-called"}' };
    },
    { calls: 0 },
  );
  return fn;
}

/**
 * A stable content hash of every editable file under the site — the byte-identical
 * rollback oracle. Matches the set history.ts snapshots (site.json, astro/brand.json,
 * astro/src/**, astro/public/assets/**, assets/**).
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

// ---------------------------------------------------------------------------
// Scenario (a) — editCopy: copy edit on a real copy key
// ---------------------------------------------------------------------------

describe.skipIf(!ASTRO_MODULES)("integration scenario (a): editCopy plan→apply→revert", () => {
  it("editCopy — plan produces op, apply passes verifier, revert restores byte-identical state", async () => {
    const { out, site } = await projectFixture();

    // Snapshot baseline for revert comparison.
    const baselineHash = editableHash(out);

    // The planner produces an editCopy op targeting a real copy key.
    const COPY_KEY = "S3StepsToSection.6";
    const NEW_TEXT = "Start your journey today — three simple steps";
    const planChat = fakePlanChat({
      needsInfo: false,
      ops: [{ op: "editCopy", copyKey: COPY_KEY, text: NEW_TEXT }],
      summary: "Updated the steps section copy.",
    });

    const conversation: ConversationTurn[] = [
      { role: "user", content: "Update the steps section text." },
    ];
    const planResult = await plan(site, conversation, planChat, MODEL);

    expect(planResult.needsInfo, "planner must not ask for more info").toBe(false);
    expect(planResult.ops).toHaveLength(1);
    expect(planResult.ops![0]).toMatchObject({ op: "editCopy", copyKey: COPY_KEY, text: NEW_TEXT });

    // Apply — verifier should pass on attempt 0 (real text change, not a no-op).
    const applyChat = fakeApplyChat();
    const result = await apply(site, planResult.ops!, { browser, chat: applyChat, model: MODEL, width: WIDTH });

    expect(result.ok, `apply must pass, failures: ${result.verifierReport.failures.join(" | ")}`).toBe(true);
    expect(result.reverted).toBeUndefined();
    expect(result.opsApplied).toHaveLength(1);
    expect(applyChat.calls, "apply revise LLM must not be called on a clean pass").toBe(0);

    // Confirm the change actually landed on disk.
    const compFile = path.join(out, "astro", "src", "components", "S3StepsToSection.astro");
    expect(fs.readFileSync(compFile, "utf8")).toContain(NEW_TEXT);

    // Revert → byte-identical to baseline snapshot (the one taken right after project()).
    revert(site);
    const afterRevertHash = editableHash(out);
    expect(afterRevertHash, "revert must restore byte-identical editable state").toBe(baselineHash);

    // Confirm the edit is gone after revert.
    expect(fs.readFileSync(compFile, "utf8")).not.toContain(NEW_TEXT);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Scenario (b) — setBrand: recolor primary to a new hex
// ---------------------------------------------------------------------------

describe.skipIf(!ASTRO_MODULES)("integration scenario (b): setBrand plan→apply→revert", () => {
  it("setBrand — primary recolor passes verifier, revert restores baseline", async () => {
    const { out, site } = await projectFixture();
    const baselineHash = editableHash(out);

    const NEW_HEX = "#0055cc"; // a clearly different blue
    const planChat = fakePlanChat({
      needsInfo: false,
      ops: [{ op: "setBrand", slot: "primary", value: NEW_HEX }],
      summary: "Changed the primary brand color to blue.",
    });

    const conversation: ConversationTurn[] = [
      { role: "user", content: "Make the primary color blue (#0055cc)." },
    ];
    const planResult = await plan(site, conversation, planChat, MODEL);

    expect(planResult.needsInfo).toBe(false);
    expect(planResult.ops).toHaveLength(1);
    expect(planResult.ops![0]).toMatchObject({ op: "setBrand", slot: "primary", value: NEW_HEX });

    const applyChat = fakeApplyChat();
    const result = await apply(site, planResult.ops!, { browser, chat: applyChat, model: MODEL, width: WIDTH });

    expect(result.ok, `apply must pass, failures: ${result.verifierReport.failures.join(" | ")}`).toBe(true);
    expect(result.reverted).toBeUndefined();
    expect(applyChat.calls, "revise LLM must not be called on a clean brand recolor").toBe(0);

    // Confirm brand.json was updated.
    const brandDoc = JSON.parse(fs.readFileSync(path.join(out, "astro", "brand.json"), "utf8")) as {
      colors: Record<string, { hex: string }>;
    };
    expect(brandDoc.colors.primary.hex).toBe(NEW_HEX);

    // Revert.
    revert(site);
    const afterRevertHash = editableHash(out);
    expect(afterRevertHash, "revert must restore byte-identical editable state").toBe(baselineHash);

    const brandAfterRevert = JSON.parse(fs.readFileSync(path.join(out, "astro", "brand.json"), "utf8")) as {
      colors: Record<string, { hex: string }>;
    };
    expect(brandAfterRevert.colors.primary.hex, "revert must restore original primary hex").not.toBe(NEW_HEX);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Scenario (c) — removeSection: remove a real section
// ---------------------------------------------------------------------------

describe.skipIf(!ASTRO_MODULES)("integration scenario (c): removeSection plan→apply→revert", () => {
  it("removeSection — section gone from DOM + site.json, revert restores baseline", async () => {
    const { out, site, manifest } = await projectFixture();
    const baselineHash = editableHash(out);

    // Use StoriesOfGlorySection — it's not first/last so removal is safe.
    const SECTION = "StoriesOfGlorySection";
    expect(
      manifest.pages[0].sections.map((s) => s.name),
      "fixture must contain the target section",
    ).toContain(SECTION);

    const planChat = fakePlanChat({
      needsInfo: false,
      ops: [{ op: "removeSection", section: SECTION }],
      summary: "Removed the testimonials section.",
    });

    const conversation: ConversationTurn[] = [
      { role: "user", content: "Remove the stories section." },
    ];
    const planResult = await plan(site, conversation, planChat, MODEL);

    expect(planResult.needsInfo).toBe(false);
    expect(planResult.ops![0]).toMatchObject({ op: "removeSection", section: SECTION });

    const applyChat = fakeApplyChat();
    const result = await apply(site, planResult.ops!, { browser, chat: applyChat, model: MODEL, width: WIDTH });

    expect(result.ok, `apply must pass, failures: ${result.verifierReport.failures.join(" | ")}`).toBe(true);
    expect(result.reverted).toBeUndefined();
    expect(applyChat.calls, "revise LLM must not be called on a clean removeSection").toBe(0);

    // Confirm section is gone from site.json.
    const afterManifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    expect(
      afterManifest.pages[0].sections.map((s) => s.name),
      "removed section must not appear in site.json after apply",
    ).not.toContain(SECTION);

    // Revert.
    revert(site);
    const afterRevertHash = editableHash(out);
    expect(afterRevertHash, "revert must restore byte-identical editable state").toBe(baselineHash);

    const revertedManifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    expect(
      revertedManifest.pages[0].sections.map((s) => s.name),
      "revert must restore removed section to site.json",
    ).toContain(SECTION);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Scenario (d) — addPage: add a new route cloned from a template page
//
// NOTE on verifier scope: addPage adds new sections to a NEW page. The render
// verifier targets only the root page (/), so the new page's sections appear in
// site.json but not in the root DOM render — a structural mismatch by design.
// For this reason, addPage is intentionally excluded from STRUCTURAL_OPS in
// apply.ts and is verified at a lighter level (per T5's documented scope):
//
//   - plan → ops (mocked LLM, real target validation)
//   - op applied: new page .astro file written + site.json updated
//   - structural: new page entry in site.json + correct sections + .astro file exists
//   - revert: restores byte-identical state (new page gone, site.json back to baseline)
//
// The root page's pixel verifier is NOT run here (that's covered by the existing
// ops.test.ts + verify.test.ts suites). This matches the test structure in
// clone.test.ts (addPage — build + structural test).
// ---------------------------------------------------------------------------

describe.skipIf(!ASTRO_MODULES)("integration scenario (d): addPage plan→apply(op-level)→revert", () => {
  it("addPage — plan produces op, op applied structurally, revert restores baseline", async () => {
    const { out, site, manifest } = await projectFixture();
    const baselineHash = editableHash(out);

    // The planner produces an addPage op.
    const ROUTE = "about";
    const planChat = fakePlanChat({
      needsInfo: false,
      ops: [{ op: "addPage", route: ROUTE }],
      summary: "Added a new /about/ page.",
    });

    const conversation: ConversationTurn[] = [
      { role: "user", content: "Add an about page." },
    ];
    const planResult = await plan(site, conversation, planChat, MODEL);

    expect(planResult.needsInfo).toBe(false);
    expect(planResult.ops).toHaveLength(1);
    expect(planResult.ops![0]).toMatchObject({ op: "addPage", route: ROUTE });

    // Apply the op directly (not via apply() which runs the full verifier —
    // see NOTE above: addPage is a lighter verify by design).
    // Import addPage from ops for the direct application.
    const { addPage } = await import("../../../src/edit/ops.ts");
    const opResult = addPage(site, ROUTE);

    expect(opResult.op.op).toBe("addPage");
    expect(opResult.targetSections.length, "addPage must produce at least one section").toBeGreaterThan(0);

    // Structural: new page in site.json.
    const afterManifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const newPage = afterManifest.pages.find((p) => p.route === "/about/");
    expect(newPage, "site.json must contain the /about/ page entry").toBeDefined();
    expect(newPage!.sections.length, "added page must have sections").toBeGreaterThan(0);

    // Original root page must still be present and intact.
    const rootPage = afterManifest.pages.find((p) => p.route === "/");
    expect(rootPage, "root page must still exist in site.json").toBeDefined();
    expect(rootPage!.sections.length).toBe(manifest.pages[0].sections.length);

    // New page .astro file exists.
    const pageFile = path.join(out, "astro", "src", "pages", `${ROUTE}.astro`);
    expect(fs.existsSync(pageFile), "about.astro must exist in src/pages/").toBe(true);

    // All copy keys in the added page use the namespaced prefix.
    for (const entry of newPage!.copy) {
      expect(
        entry.key.startsWith("About"),
        `copy key '${entry.key}' must be namespaced with 'About'`,
      ).toBe(true);
    }

    // Revert.
    revert(site);
    const afterRevertHash = editableHash(out);
    expect(afterRevertHash, "revert must restore byte-identical editable state").toBe(baselineHash);

    const revertedManifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    expect(
      revertedManifest.pages.find((p) => p.route === "/about/"),
      "revert must remove the added page from site.json",
    ).toBeUndefined();
    expect(
      fs.existsSync(pageFile),
      "revert must remove the added page .astro file",
    ).toBe(false);
  }, 300_000);
});
