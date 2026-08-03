import fs from "node:fs";
import type { HarvestedSection, Archetype, LibraryStore } from "./types.ts";
import { fingerprint } from "./fingerprint.ts";
import { enumerateKnobs, modalDefaults } from "./knobs.ts";

/** A fresh, empty library store. */
export function emptyLibrary(): LibraryStore {
  return { version: 1, archetypes: {}, report: [] };
}

/**
 * Cluster harvested sections into archetypes keyed by fingerprint hash. Popularity is
 * site-level: a site contributes AT MOST ONE vote per archetype (so a site repeating a pattern
 * doesn't inflate it). Knobs are enumerated from the group's members; defaults are modal.
 */
export function clusterArchetypes(sections: HarvestedSection[]): Record<string, Archetype> {
  const groups = new Map<string, HarvestedSection[]>();
  for (const s of sections) {
    const fp = fingerprint(s);
    const arr = groups.get(fp.hash) ?? [];
    arr.push(s);
    groups.set(fp.hash, arr);
  }
  const out: Record<string, Archetype> = {};
  for (const [hash, members] of groups) {
    const fp = fingerprint(members[0]);
    const sites = [...new Set(members.map((m) => m.sourceSite))];
    out[hash] = {
      fingerprint: fp,
      sites,
      knobs: enumerateKnobs(members),
      knobDefaults: modalDefaults(members),
      status: "quarantine", // governance (promote.ts) decides admission
    };
  }
  return out;
}

/** Persist the library to a JSON file (stable 2-space formatting for reviewable diffs). */
export function saveLibrary(file: string, lib: LibraryStore): void {
  fs.writeFileSync(file, JSON.stringify(lib, null, 2) + "\n");
}

/** Load a library from disk, or return an empty one if the file does not exist. */
export function loadLibrary(file: string): LibraryStore {
  if (!fs.existsSync(file)) return emptyLibrary();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`loadLibrary: failed to parse ${file}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new Error(`loadLibrary: ${file} is not a valid LibraryStore (expected version:1)`);
  }
  return parsed as LibraryStore;
}
