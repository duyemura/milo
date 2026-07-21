import { SECTION_TYPES } from "@milo/schema";

export type Manifest = { id: string; name: string; designLanguage: string; implements: Record<string, string> };

export function resolveComponent(manifest: Manifest, section: string): string {
  const file = manifest.implements[section];
  if (!file) throw new Error(`theme "${manifest.id}" does not implement section "${section}"`);
  return file;
}

/** Shared sections the theme has not implemented yet (Plan 1b closes this to []). */
export function missingSections(manifest: Manifest): string[] {
  return [...SECTION_TYPES].filter((t) => !manifest.implements[t]);
}
