/**
 * history.ts — snapshot + revert (reversible edits) for subsystem C.
 *
 * A "snapshot" is a versioned copy of the site's EDITABLE inputs stored under
 * `<site.dir>/.edit-history/<n>/`. The heavy regenerable outputs (node_modules,
 * dist/) are never copied — only the files that ops.ts can mutate:
 *
 *   site.json                          — manifest
 *   astro/brand.json                   — brand tokens
 *   astro/src/**                       — pages, components, styles
 *   astro/public/assets/               — rehosted asset files (swapAsset target)
 *   assets/                            — root-level asset copy (present in some layouts)
 *
 * `restore` is a TRUE restore, not just an overwrite: it mirrors each covered
 * subtree exactly — deleting files that were added after the snapshot was taken.
 *
 * `revert(site, toVersion?)` is the one-shot undo: restore the last snapshot
 * (or a specific version) and return the restored token.
 *
 * Pruning: after each snapshot the store is trimmed to MAX_SNAPSHOTS (10) most
 * recent versions; older versions are removed.
 */
import fs from "node:fs";
import path from "node:path";
import type { SiteRef } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ".edit-history";
const MAX_SNAPSHOTS = 10;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Absolute path to the history store for this site. */
function historyRoot(site: SiteRef): string {
  return path.join(site.dir, HISTORY_DIR);
}

/** Sorted numeric version IDs present in the history store (ascending). */
function listVersions(site: SiteRef): number[] {
  const root = historyRoot(site);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((n) => parseInt(n, 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
}

/**
 * The set of paths (relative to site.dir) that ops.ts touches — the "editable
 * state" that snapshot must capture and restore must mirror exactly.
 *
 * We enumerate SUBTREES rather than individual files so that newly added files
 * (addSection, addPage) are automatically included.
 *
 * Returns a list of { src, rel } pairs where src is the absolute source path
 * and rel is the path relative to site.dir (used as the layout inside the snapshot).
 */
function editableEntries(siteDir: string): Array<{ src: string; rel: string }> {
  const entries: Array<{ src: string; rel: string }> = [];

  // Enumerate one subtree, recursing into directories.
  function walk(abs: string, rel: string): void {
    if (!fs.existsSync(abs)) return;
    const stat = fs.statSync(abs);
    if (stat.isSymbolicLink()) return; // never follow symlinks (node_modules symlink guard)
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(abs)) {
        walk(path.join(abs, child), path.join(rel, child));
      }
    } else {
      entries.push({ src: abs, rel });
    }
  }

  // 1. site.json
  const siteJsonAbs = path.join(siteDir, "site.json");
  if (fs.existsSync(siteJsonAbs)) {
    entries.push({ src: siteJsonAbs, rel: "site.json" });
  }

  // 2. astro/brand.json
  const brandAbs = path.join(siteDir, "astro", "brand.json");
  if (fs.existsSync(brandAbs)) {
    entries.push({ src: brandAbs, rel: path.join("astro", "brand.json") });
  }

  // 3. astro/src/** (pages, components, styles — all of it)
  walk(path.join(siteDir, "astro", "src"), path.join("astro", "src"));

  // 4. astro/public/assets/ — swapAsset rewrites files here
  walk(
    path.join(siteDir, "astro", "public", "assets"),
    path.join("astro", "public", "assets"),
  );

  // 5. assets/ (root-level copy present in some capture+project combined layouts)
  walk(path.join(siteDir, "assets"), "assets");

  return entries;
}

/**
 * Copy the editable state to a new snapshot directory.
 * Returns the canonical relative paths included in the snapshot (used by restore
 * to know which subtrees to mirror).
 */
function writeSnapshot(siteDir: string, snapDir: string): Set<string> {
  const entries = editableEntries(siteDir);
  const included = new Set<string>();

  for (const { src, rel } of entries) {
    const dest = path.join(snapDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);

    // Record the root subtree prefix so restore knows the covered scope.
    // For "site.json" → top-level file; for "astro/src/..." → "astro/src"; etc.
    const parts = rel.split(path.sep);
    if (parts.length === 1) {
      included.add(rel); // top-level file like "site.json"
    } else {
      // Root subtree: first 3 path segments (e.g. astro/src, astro/public/assets, assets)
      // We store the actual sub-path rather than collapsing to a subtree — restore will
      // do a symmetric diff at the subtree level.
      included.add(rel);
    }
  }

  return included;
}

/**
 * Restore a snapshot directory back over the live editable files.
 *
 * True-restore semantics: for each covered subtree, the live tree is made to
 * look exactly like the snapshot — files added after the snapshot are deleted,
 * missing files are restored.
 *
 * "Covered subtrees" are determined by the top-level entries in the snapshot:
 *   - "site.json" (top-level file)
 *   - "astro/brand.json" (top-level file under astro/)
 *   - "astro/src" (directory subtree)
 *   - "astro/public/assets" (directory subtree)
 *   - "assets" (directory subtree, if present in snapshot)
 */
function applySnapshot(snapDir: string, siteDir: string): void {
  // Determine which subtrees the snapshot covers.
  const coveredSubtrees = snapshotCoveredSubtrees(snapDir);

  for (const subtree of coveredSubtrees) {
    const snapSubtree = path.join(snapDir, subtree);
    const liveSubtree = path.join(siteDir, subtree);

    const snapStat = fs.existsSync(snapSubtree)
      ? fs.statSync(snapSubtree)
      : null;

    if (snapStat && !snapStat.isDirectory()) {
      // Top-level file (e.g. site.json, astro/brand.json).
      fs.mkdirSync(path.dirname(liveSubtree), { recursive: true });
      fs.copyFileSync(snapSubtree, liveSubtree);
    } else if (snapStat && snapStat.isDirectory()) {
      // Directory subtree: mirror exactly.
      mirrorDir(snapSubtree, liveSubtree);
    } else {
      // Subtree was NOT in the snapshot (e.g. assets/ didn't exist at snapshot time).
      // Delete the live version if it now exists.
      if (fs.existsSync(liveSubtree)) {
        fs.rmSync(liveSubtree, { recursive: true, force: true });
      }
    }
  }
}

/**
 * Determine the covered subtrees from a snapshot directory's top-level layout.
 *
 * We always cover the same fixed set of subtrees (those editableEntries captures),
 * regardless of what the snapshot actually contains — this ensures that files added
 * after the snapshot (into astro/src/, assets/, etc.) are properly removed on restore.
 */
function snapshotCoveredSubtrees(snapDir: string): string[] {
  // Fixed set of subtrees that editableEntries() covers.
  // Listed in a way that avoids double-processing (site.json at top, astro/brand.json
  // as a direct file, astro/src + astro/public/assets as subtrees, assets as subtree).
  const subtrees = [
    "site.json",
    path.join("astro", "brand.json"),
    path.join("astro", "src"),
    path.join("astro", "public", "assets"),
    "assets",
  ];
  // Only include subtrees that actually exist in the snapshot OR in a superset context —
  // we always include all to guarantee deletions are handled.
  // (The snapshot dir itself may not have "assets" if it wasn't present — applySnapshot
  //  handles the absent-in-snapshot case by deleting the live version.)
  return subtrees;
}

/**
 * Mirror `srcDir` onto `destDir` exactly:
 *   - files in snapshot but not live → copy to live
 *   - files in both → overwrite live
 *   - files in live but not snapshot → delete from live
 */
function mirrorDir(srcDir: string, destDir: string): void {
  // Collect all relative paths in the source (snapshot).
  const snapFiles = new Set<string>();
  walkRel(srcDir, "", snapFiles);

  // Collect all relative paths currently in the dest (live).
  const liveFiles = new Set<string>();
  walkRel(destDir, "", liveFiles);

  // Delete files that exist in live but not in snapshot.
  for (const rel of liveFiles) {
    if (!snapFiles.has(rel)) {
      fs.rmSync(path.join(destDir, rel), { force: true });
    }
  }

  // Copy/overwrite all snapshot files into live.
  for (const rel of snapFiles) {
    const src = path.join(srcDir, rel);
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  // Prune empty directories left behind by deletions.
  pruneEmptyDirs(destDir);
}

/** Collect all file paths relative to `base` into `out` (files only, no dirs). */
function walkRel(abs: string, rel: string, out: Set<string>): void {
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(abs)) {
      walkRel(
        path.join(abs, child),
        rel ? path.join(rel, child) : child,
        out,
      );
    }
  } else {
    if (rel) out.add(rel);
  }
}

/** Remove empty directories under `dir` (bottom-up). */
function pruneEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const child of fs.readdirSync(dir)) {
    const childAbs = path.join(dir, child);
    const stat = fs.statSync(childAbs);
    if (stat.isDirectory()) {
      pruneEmptyDirs(childAbs);
      // Re-check after recursive prune.
      if (fs.readdirSync(childAbs).length === 0) {
        fs.rmdirSync(childAbs);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Take a snapshot of the site's editable state.
 *
 * Copies site.json, astro/brand.json, astro/src/**, astro/public/assets/**, and
 * assets/** (if present) to `<site.dir>/.edit-history/<n>/`. Returns the version
 * token (a numeric string, e.g. `"3"`).
 *
 * Prunes snapshots older than MAX_SNAPSHOTS after writing.
 */
export function snapshot(site: SiteRef): string {
  const root = historyRoot(site);
  fs.mkdirSync(root, { recursive: true });

  const existing = listVersions(site);
  const nextN = existing.length > 0 ? existing[existing.length - 1] + 1 : 0;
  const token = String(nextN);
  const snapDir = path.join(root, token);

  fs.mkdirSync(snapDir, { recursive: true });
  writeSnapshot(site.dir, snapDir);

  // Prune oldest snapshots beyond MAX_SNAPSHOTS.
  const all = listVersions(site);
  if (all.length > MAX_SNAPSHOTS) {
    const toRemove = all.slice(0, all.length - MAX_SNAPSHOTS);
    for (const v of toRemove) {
      fs.rmSync(path.join(root, String(v)), { recursive: true, force: true });
    }
  }

  return token;
}

/**
 * Restore the snapshot at `token` back over the live editable files.
 *
 * True-restore: files added since the snapshot was taken (under the covered
 * subtrees) are deleted. Files that existed in the snapshot but were removed
 * from the live tree are restored.
 *
 * Throws if the snapshot token does not exist.
 */
export function restore(site: SiteRef, token: string): void {
  const snapDir = path.join(historyRoot(site), token);
  if (!fs.existsSync(snapDir)) {
    throw new Error(
      `restore: snapshot "${token}" not found in ${historyRoot(site)}`,
    );
  }
  applySnapshot(snapDir, site.dir);
}

/**
 * Restore the last snapshot (or a specific version) and return the restored token.
 *
 * If `toVersion` is omitted, the most recent snapshot is used.
 * Throws a clear error if no snapshots exist.
 */
export function revert(site: SiteRef, toVersion?: string): string {
  const versions = listVersions(site);
  if (versions.length === 0) {
    throw new Error(
      `revert: no snapshots found in ${historyRoot(site)}. Call snapshot() before editing.`,
    );
  }

  const token =
    toVersion !== undefined
      ? toVersion
      : String(versions[versions.length - 1]);

  restore(site, token);
  return token;
}
