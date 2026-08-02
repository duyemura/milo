/**
 * revert.test.ts — snapshot + restore + revert (C-T6, no browser required).
 *
 * All tests are deterministic: they project the speakeasy golden, mutate the
 * live editable files, then verify snapshot/revert semantics at the byte level.
 *
 * Test 1 — Round-trip (copy edit):
 *   snapshot → editCopy (sentinel) → assert sentinel in file
 *   → revert → assert file is byte-identical to pre-snapshot bytes.
 *
 * Test 2 — Structural round-trip (addSection):
 *   snapshot → addSection → assert new component file EXISTS + site.json grew
 *   → revert → assert added component file is GONE + site.json byte-identical.
 *
 * Test 3 — revert with no snapshot throws a clear error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../src/project.ts";
import { editCopy, addSection } from "../../src/edit/ops.ts";
import { snapshot, restore, revert } from "../../src/edit/history.ts";
import type { SiteRef } from "../../src/edit/types.ts";
import type { SiteManifest } from "../../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(dir, "../golden/speakeasy");

// ---------------------------------------------------------------------------
// Shared projection (one project() call for all tests)
// ---------------------------------------------------------------------------

let outDir: string;
let site: SiteRef;
let manifest: SiteManifest;

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "revert-test-"));
  await project({ dir: GOLDEN, out: outDir, trim: true, noDiff: true });
  site = { dir: outDir };
  manifest = JSON.parse(
    fs.readFileSync(path.join(outDir, "site.json"), "utf8"),
  ) as SiteManifest;
}, 180_000);

afterAll(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 — Round-trip via editCopy
// ---------------------------------------------------------------------------

describe("snapshot + revert — round-trip (editCopy)", () => {
  it("restores the component file to byte-identical bytes after editCopy", () => {
    // Use a fresh sub-dir so concurrent tests don't interfere.
    const subOut = fs.mkdtempSync(path.join(os.tmpdir(), "revert-copy-"));
    try {
      // Project a fresh copy.
      // (We re-use the already-projected outDir for speed — just clone the astro src.)
      // We can use site directly since each test in this file runs sequentially.
      // BUT: because the shared `site` is mutated by later tests, we isolate with a
      // per-test temp dir cloned from the shared projection.
      const site2 = cloneSite(outDir, subOut);
      const manifest2 = JSON.parse(
        fs.readFileSync(path.join(subOut, "site.json"), "utf8"),
      ) as SiteManifest;

      const page = manifest2.pages[0];
      expect(page.copy.length, "need at least one copy entry").toBeGreaterThan(0);
      const entry = page.copy[0];

      // Resolve the component file path.
      const componentFile = path.join(
        subOut,
        "astro",
        "src",
        "components",
        `${entry.component}.astro`,
      );

      // Read the original bytes BEFORE the snapshot.
      const beforeBytes = fs.readFileSync(componentFile);

      // Take snapshot.
      const token = snapshot(site2);
      expect(token).toBeTruthy();

      // Mutate with a sentinel string.
      const SENTINEL = "REVERT_TEST_SENTINEL_ABC";
      editCopy(site2, entry.key, SENTINEL);

      // Assert the mutation is visible.
      const afterMutate = fs.readFileSync(componentFile, "utf8");
      expect(afterMutate).toContain(SENTINEL);

      // Revert.
      const restoredToken = revert(site2);
      expect(restoredToken).toBe(token);

      // Assert the file is byte-identical to before-snapshot bytes.
      const afterRevert = fs.readFileSync(componentFile);
      expect(afterRevert.equals(beforeBytes)).toBe(true);
    } finally {
      fs.rmSync(subOut, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Structural round-trip (addSection: file-added + site.json grows)
// ---------------------------------------------------------------------------

describe("snapshot + revert — structural round-trip (addSection)", () => {
  it("deletes the added component file and restores site.json byte-for-byte", () => {
    const subOut = fs.mkdtempSync(path.join(os.tmpdir(), "revert-add-"));
    try {
      const site2 = cloneSite(outDir, subOut);
      const manifest2 = JSON.parse(
        fs.readFileSync(path.join(subOut, "site.json"), "utf8"),
      ) as SiteManifest;

      // Identify a section to clone — use the first section of the first page.
      const page = manifest2.pages[0];
      expect(page.sections.length, "need at least one section").toBeGreaterThan(0);
      const cloneOfSection = page.sections[0].name;

      // Read site.json bytes BEFORE the snapshot.
      const siteJsonPath = path.join(subOut, "site.json");
      const siteJsonBefore = fs.readFileSync(siteJsonPath);

      // Take snapshot.
      const token = snapshot(site2);
      expect(token).toBeTruthy();

      // Add a section — this creates a new .astro component + updates site.json.
      const result = addSection(site2, cloneOfSection);
      expect(result.targetSections).toHaveLength(1);
      const newName = result.targetSections[0];

      // Assert: the new component file EXISTS after addSection.
      const newCompFile = path.join(
        subOut,
        "astro",
        "src",
        "components",
        `${newName}.astro`,
      );
      expect(fs.existsSync(newCompFile), "new component file should exist after addSection").toBe(
        true,
      );

      // Assert: site.json grew (has one more section entry).
      const manifestAfterAdd = JSON.parse(
        fs.readFileSync(siteJsonPath, "utf8"),
      ) as SiteManifest;
      const sectionNamesAfter = manifestAfterAdd.pages[0].sections.map((s) => s.name);
      expect(sectionNamesAfter).toContain(newName);
      expect(manifestAfterAdd.pages[0].sections.length).toBe(
        page.sections.length + 1,
      );

      // Revert.
      const restoredToken = revert(site2);
      expect(restoredToken).toBe(token);

      // Assert: the added component file is GONE.
      expect(
        fs.existsSync(newCompFile),
        "added component file must be gone after revert",
      ).toBe(false);

      // Assert: site.json is byte-identical to before-snapshot bytes.
      const siteJsonAfterRevert = fs.readFileSync(siteJsonPath);
      expect(siteJsonAfterRevert.equals(siteJsonBefore)).toBe(true);
    } finally {
      fs.rmSync(subOut, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — revert with no snapshot throws a clear error
// ---------------------------------------------------------------------------

describe("revert — no snapshot throws", () => {
  it("throws with a clear error message when no snapshots exist", () => {
    const emptyOut = fs.mkdtempSync(path.join(os.tmpdir(), "revert-nosnap-"));
    try {
      const emptySite: SiteRef = { dir: emptyOut };
      // The history dir does not exist → should throw.
      expect(() => revert(emptySite)).toThrow(/no snapshots found/i);
    } finally {
      fs.rmSync(emptyOut, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clone the editable state from an already-projected site into a fresh dir.
 * Uses fs.cpSync to copy everything except node_modules, dist, and .edit-history.
 */
function cloneSite(srcDir: string, destDir: string): SiteRef {
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter(src) {
      const rel = path.relative(srcDir, src);
      // Skip node_modules, dist, and .edit-history.
      const parts = rel.split(path.sep);
      if (parts[0] === "node_modules") return false;
      if (parts[0] === "dist") return false;
      if (parts[0] === ".edit-history") return false;
      // Also skip the astro/node_modules symlink.
      if (parts[0] === "astro" && parts[1] === "node_modules") return false;
      return true;
    },
  });
  return { dir: destDir };
}
