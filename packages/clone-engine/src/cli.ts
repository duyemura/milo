/**
 * engine-select CLI
 *
 * Usage:
 *   node src/cli.ts <subcommand> [flags] [--engine <ts|mjs>]
 *
 * Subcommands:
 *   capture  --url <url> --out <dir>
 *   project  --dir <dir> --out <outDir> [--base <base>] [--links <file>]
 *   build    (whole-site orchestrator; runs from cwd)
 *   deploy   --dist <distDir> --slug <slug>
 *
 * --engine defaults to "mjs" (the frozen, proven spike scripts).
 * --engine ts calls the ported TypeScript functions directly.
 */
import { capture } from "./capture.ts";
import { project } from "./project.ts";
import { buildSite } from "./orchestrate.ts";
import { deploy } from "./deploy.ts";
import { mjsCapture, mjsProject, mjsBuild } from "./run-mjs.ts";
import path from "node:path";

// ---------------------------------------------------------------------------
// Minimal arg parser
// ---------------------------------------------------------------------------

function arg(name: string, defaultVal?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return defaultVal;
  return process.argv[i + 1];
}

function requireArg(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Default Speakeasy page list (backwards-compat with build-site.mjs behaviour)
// ---------------------------------------------------------------------------

const SPEAKEASY_ORIGIN = "https://speakeasyofstrength.com";
const SPEAKEASY_PAGES = [
  { route: "/", dir: "dist-se-full" },
  { route: "/about/", dir: "sw-about" },
  { route: "/testimonials/", dir: "dist-se-testimonials" },
  { route: "/locations/", dir: "sw-locations" },
  { route: "/locations/gym-in-brooklyn-new-york/", dir: "sw-bk" },
  { route: "/locations/gym-in-hells-kitchen-new-york/", dir: "sw-hk" },
  { route: "/virtual-classes/", dir: "sw-virtual" },
  { route: "/programs-in-brooklyn-new-york/", dir: "sw-progbk" },
  { route: "/blog/", dir: "sw-blog" },
  { route: "/reasons-you-gain-weight-vacation/", dir: "sw-post1" },
  { route: "/ladies-optimal-fuel-workouts-nutrient/", dir: "sw-post2" },
  { route: "/monavie-superfood-or-super-rip-off/", dir: "sw-post3" },
];

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

const [subcommand] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const engine = arg("engine", "mjs");

if (!subcommand) {
  console.error("Usage: node src/cli.ts <capture|project|build|deploy> [--engine <ts|mjs>] [flags]");
  process.exit(1);
}

switch (subcommand) {
  case "capture": {
    const url = requireArg("url");
    const out = requireArg("out");
    if (engine === "ts") {
      await capture({ url, out, verify: false });
    } else {
      mjsCapture(url, out);
    }
    break;
  }

  case "project": {
    const dir = requireArg("dir");
    const out = requireArg("out");
    const base = arg("base", "");
    const links = arg("links");
    if (engine === "ts") {
      await project({ dir, out, base, links, noDiff: true });
    } else {
      // Only pass --links when the caller supplied it; project-page.mjs defaults to {} when omitted.
      const resolvedLinks = links ? path.resolve(links) : undefined;
      mjsProject(path.resolve(dir), path.resolve(out), base ?? "", resolvedLinks);
    }
    break;
  }

  case "build": {
    if (engine === "ts") {
      await buildSite({ origin: SPEAKEASY_ORIGIN, pages: SPEAKEASY_PAGES });
    } else {
      mjsBuild();
    }
    break;
  }

  case "deploy": {
    const dist = requireArg("dist");
    const slug = requireArg("slug");
    if (engine === "mjs") {
      console.error("deploy subcommand only supports --engine ts (the mjs script is not a standalone entrypoint)");
      process.exit(1);
    }
    await deploy({ distDir: path.resolve(dist), slug });
    break;
  }

  default: {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Valid subcommands: capture, project, build, deploy");
    process.exit(1);
  }
}
