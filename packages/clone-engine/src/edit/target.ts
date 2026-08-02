/**
 * target.ts — resolve edit handles against site.json (the hallucination guard).
 *
 * Every edit op goes through a resolver before touching any file. If the requested
 * target (copy key, section name, element role, asset alias) is not present in
 * site.json, a TargetError is thrown — the file is never opened.
 */
import fs from "node:fs";
import path from "node:path";
import type { SiteRef } from "./types.ts";
import type { SiteManifest } from "../types.ts";

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

/** Read and parse site.json from an OUT dir. */
export function loadSite(site: SiteRef): SiteManifest {
  const p = path.join(site.dir, "site.json");
  if (!fs.existsSync(p)) throw new TargetError(`site.json not found in ${site.dir}`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as SiteManifest;
}

/**
 * Resolve a copy key (e.g. "HeroSection.0") → the component file (absolute path)
 * and the content[] index inside it.
 */
export function resolveCopy(
  site: SiteRef,
  copyKey: string,
): { file: string; contentIndex: number; component: string } {
  const manifest = loadSite(site);
  for (const page of manifest.pages) {
    const entry = page.copy.find((c) => c.key === copyKey);
    if (entry) {
      // The manifest section file is relative to OUT (e.g. "astro/src/components/HeroSection.astro").
      // We find the owning section's file to get the explicit path; fall back to the component name.
      const section = page.sections.find((s) => s.name === entry.component || s.file.endsWith(`/${entry.component}.astro`));
      const file = section
        ? path.join(site.dir, section.file)
        : path.join(site.dir, "astro", "src", "components", `${entry.component}.astro`);
      return { file, contentIndex: entry.index, component: entry.component };
    }
  }
  throw new TargetError(`copy key not found in site.json: ${copyKey}`);
}

/**
 * Resolve a section handle (data-section role OR component name) → the component
 * file (absolute path) and the canonical component name.
 *
 * Matches on section.role first (role = "hero" etc.), then on section.name
 * (component name = "HeroSection"). The first match wins.
 */
export function resolveSection(
  site: SiteRef,
  section: string,
): { file: string; name: string } {
  const manifest = loadSite(site);
  for (const page of manifest.pages) {
    const s =
      page.sections.find((s) => s.role === section) ??
      page.sections.find((s) => s.name === section);
    if (s) return { file: path.join(site.dir, s.file), name: s.name };
  }
  throw new TargetError(`section not found in site.json: ${section}`);
}

/**
 * Resolve an element role handle → the CSS selector + the owning component (if known).
 * If the role appears in multiple sections, the first occurrence wins.
 */
export function resolveElement(
  site: SiteRef,
  role: string,
): { selector: string; component: string | null } {
  const manifest = loadSite(site);
  for (const page of manifest.pages) {
    const el = page.elements.find((e) => e.role === role);
    if (el) return { selector: el.selector, component: el.component || null };
  }
  throw new TargetError(`element role not found in site.json: ${role}`);
}

/**
 * Resolve an asset alias (e.g. "logo") → the absolute file path on disk.
 * The manifest stores the path relative to OUT (e.g. "assets/a1.png").
 */
export function resolveAsset(site: SiteRef, alias: string): { file: string } {
  const manifest = loadSite(site);
  for (const page of manifest.pages) {
    const a = page.assets.find((a) => a.alias === alias);
    if (a) return { file: path.join(site.dir, a.file) };
  }
  throw new TargetError(`asset alias not found in site.json: ${alias}`);
}
