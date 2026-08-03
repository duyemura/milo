/**
 * astro.ts — locate the engine's own Astro 4.x installation.
 *
 * The engine declares `astro@^4.16` as a direct dependency. Every function that
 * needs to run `astro build` should import `findAstroPath` from here rather than
 * hard-coding a path to page-clone-spike/ or reading ASTRO_MODULES manually.
 *
 * Resolution order (first found wins):
 *   1. ASTRO_MODULES env var  — override for CI / custom environments
 *   2. packages/clone-engine/node_modules  — the engine's own installed Astro (primary)
 *   3. repo root node_modules  — fallback (monorepo-level install)
 */
import fs from "node:fs";
import path from "node:path";

const ENGINE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * Return the node_modules directory that contains a usable Astro 4.x install,
 * or null if none can be found.
 */
export function findAstroModules(): string | null {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(ENGINE_DIR, "node_modules"),
    path.join(ENGINE_DIR, "../..", "node_modules"),
  ].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "astro", "astro.js"))) return c;
    // flat npm layout (astro.js at root of .bin-adjacent location)
    if (fs.existsSync(path.join(c, ".bin", "astro"))) return c;
  }
  return null;
}

/**
 * Return the absolute path to the `astro.js` entry point, or throw.
 * Use with `spawnSync("node", [findAstroJs(), "build"], { cwd: astroProjectDir })`.
 */
export function findAstroJs(): string {
  const mods = findAstroModules();
  if (!mods) throw new Error("astro: no Astro install found. Install astro@^4.16 or set ASTRO_MODULES.");

  // pnpm: node_modules/astro/astro.js (symlink through .pnpm store)
  const direct = path.join(mods, "astro", "astro.js");
  if (fs.existsSync(direct)) return direct;

  // flat npm: node_modules/.bin/astro is a proper Node wrapper
  const bin = path.join(mods, ".bin", "astro");
  if (fs.existsSync(bin)) return bin;

  throw new Error(`astro: found node_modules at ${mods} but astro.js and .bin/astro are both absent`);
}
