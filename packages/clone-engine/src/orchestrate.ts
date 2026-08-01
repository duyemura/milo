/**
 * Whole-site orchestrator: capture → project(base+links) → astro build → assemble.
 *
 * Ported from page-clone-spike/build-site.mjs. Key changes from the original:
 *   1. Hardcoded origin + PAGES moved into `opts`; the Speakeasy list is kept as
 *      the default in the CLI, not here — callers must supply both.
 *   2. `execSync("node page-clone.mjs …")` and `execSync("node project-page.mjs …")`
 *      replaced by direct calls to the TS `capture()` and `project()` functions.
 *   3. `astro build` and `cp -R` still shell out — those are external tools.
 *
 * All crawl/link-map/per-page/assemble logic is otherwise identical to the spike.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { capture } from "./capture.ts";
import { project } from "./project.ts";

export interface PageSpec {
  route: string;
  /** The capture output directory (e.g. "dist-se-full"). */
  dir: string;
}

export interface BuildSiteOpts {
  origin: string;
  pages: PageSpec[];
  /** Working directory for the build. Defaults to process.cwd(). */
  cwd?: string;
}

export async function buildSite(opts: BuildSiteOpts): Promise<{ ok: PageSpec[] }> {
  const { origin, pages } = opts;
  const cwd = opts.cwd ?? process.cwd();

  // Augment pages with derived url + out fields (mirrors build-site.mjs PAGES.forEach).
  const augmented = pages.map((p) => ({
    ...p,
    url: origin + p.route,
    out: p.route === "/" ? "sp-home" : "sp-" + p.route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""),
  }));

  // Full internal link map (both slash forms) so nav rewrites everywhere.
  const links: Record<string, string> = {};
  for (const p of augmented) {
    links[p.url] = p.route;
    links[p.url.replace(/\/$/, "")] = p.route;
  }
  const linksFile = path.join(cwd, "links-site.json");
  fs.writeFileSync(linksFile, JSON.stringify(links, null, 1));

  const ok: PageSpec[] = [];

  for (const p of augmented) {
    try {
      const captureJsonPath = path.join(cwd, p.dir, "capture.json");
      if (!fs.existsSync(captureJsonPath)) {
        console.log(`\n=== CAPTURE ${p.route} ===`);
        await capture({ url: p.url, out: path.join(cwd, p.dir), verify: false });
      } else {
        console.log(`\n=== capture cached ${p.route} ===`);
      }

      const base = p.route === "/" ? "" : p.route.replace(/\/$/, "");
      console.log(`=== PROJECT ${p.route} (base='${base}') ===`);
      await project({
        dir: path.join(cwd, p.dir),
        out: path.join(cwd, p.out),
        base,
        links: linksFile,
        noDiff: true,
      });

      // astro build shells out — it is an external tool, not a TS function.
      const astroDir = path.join(cwd, p.out, "astro");
      execSync(
        `ln -sf ../../out-project-page/astro/node_modules node_modules && ./node_modules/.bin/astro build`,
        { cwd: astroDir, stdio: "inherit", shell: "/bin/bash" },
      );

      ok.push(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`!!! FAILED ${p.route}: ${msg.split("\n")[0]}`);
    }
  }

  // Assemble full-site/ from all successful page builds.
  const fullSite = path.join(cwd, "full-site");
  fs.rmSync(fullSite, { recursive: true, force: true });
  fs.mkdirSync(fullSite);

  for (const p of ok) {
    const dest =
      p.route === "/"
        ? fullSite
        : path.join(fullSite, p.route.replace(/^\/|\/$/g, ""));
    fs.mkdirSync(dest, { recursive: true });
    const astroDist = path.join(cwd, p.out, "astro/dist");
    execSync(`cp -R ${astroDist}/. ${dest}/`, { stdio: "inherit", shell: "/bin/bash" });
  }

  console.log(
    `\n✓ assembled full-site/ with ${ok.length}/${augmented.length} pages: ${ok.map((p) => p.route).join("  ")}`,
  );

  return { ok };
}
