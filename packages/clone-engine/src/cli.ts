/**
 * engine-select CLI
 *
 * Usage:
 *   node src/cli.ts <subcommand> [flags] [--engine <ts|mjs>]
 *
 * Subcommands:
 *   capture  --url <url> --out <dir>
 *   label    --dir <dir> [--out <dir>] [--no-llm]
 *   project  --dir <dir> --out <outDir> [--base <base>] [--links <file>]
 *   build    (whole-site orchestrator; runs from cwd)
 *   deploy   --dist <distDir> --slug <slug>
 *
 * --engine defaults to "ts" (the ported TypeScript engine, at parity with the .mjs spike).
 * --engine mjs falls back to the frozen, proven spike scripts.
 */
import { capture } from "./capture.ts";
import { project } from "./project.ts";
import { label } from "./labels.ts";
import { buildSite, buildSiteAuto } from "./orchestrate.ts";
import { crawlSite } from "./crawl.ts";
import { deploy } from "./deploy.ts";
import { mjsCapture, mjsProject, mjsBuild } from "./run-mjs.ts";
import { eventToJsonLine, type EngineEventSink } from "./events.ts";
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

/** True if a boolean `--flag` is present anywhere in argv (no value consumed). */
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Parse an optional positive-integer arg. Absent → undefined; present but not a
 *  positive integer → exit with a clear error (rather than silently becoming NaN). */
function optPosIntArg(name: string): number | undefined {
  const s = arg(name);
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Error: --${name} must be a positive integer (got "${s}").`);
    process.exit(1);
  }
  return n;
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

// Find the subcommand position-independently: walk argv, skipping any `--flag`
// and the token immediately after it (its value). All our flags take a value,
// so treating `--x y` as a pair is robust. The first remaining bare token is
// the subcommand — so `--engine ts project …` and `project … --engine ts` both work.
// Boolean flags take NO value, so we must not consume the token after them.
const BOOLEAN_FLAGS = new Set(["no-llm", "emit-events"]);

function findSubcommand(): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      if (!BOOLEAN_FLAGS.has(tok.slice(2))) i++; // skip this flag's value (unless it's a boolean flag)
      continue;
    }
    return tok;
  }
  return undefined;
}

const subcommand = findSubcommand();
const engine = arg("engine", "ts");

if (!subcommand) {
  console.error("Usage: node src/cli.ts <capture|label|project|build|build-site|build-auto|deploy> [--engine <ts|mjs>] [flags]");
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

  case "label": {
    // node src/cli.ts label --dir <d> [--out <d>] [--no-llm]
    // Reads <dir>/capture.json, computes labels (LLM if configured + not --no-llm,
    // else deterministic heuristic), writes labels.json, prints a summary.
    const dir = requireArg("dir");
    const out = arg("out");
    const noLlm = hasFlag("no-llm");
    const { labels, source, fallbackReason } = await label({ dir, out, llm: !noLlm });
    const roleCounts = labels.sections.reduce<Record<string, number>>((m, s) => {
      m[s.role] = (m[s.role] ?? 0) + 1;
      return m;
    }, {});
    console.log(
      `  labels: site "${labels.site.name}" — ${labels.sections.length} sections, ` +
      `${labels.brand.colors.length} brand colors, ${labels.brand.fonts.length} fonts, ` +
      `${labels.elements.length} elements, ${labels.assets.length} assets`,
    );
    console.log(`  section roles: ${Object.entries(roleCounts).map(([r, n]) => `${r}×${n}`).join(", ")}`);
    console.log(`  label source: ${source}${fallbackReason ? ` (reason: ${fallbackReason})` : ""}`);
    console.log(`  → wrote ${path.join(path.resolve(out ?? dir), "labels.json")}`);
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

  case "build-site": {
    // Crawl + build a whole site from an origin URL.
    // node src/cli.ts build-site --site <origin> --out <report.html> [--cwd <dir>]
    const site = requireArg("site");
    const reportOut = requireArg("out");
    const buildCwd = arg("cwd", process.cwd());
    const concurrency = optPosIntArg("concurrency");

    console.log(`[build-site] Crawling ${site}...`);
    const routes = await crawlSite(site);
    console.log(`[build-site] Discovered ${routes.length} routes: ${routes.join(", ")}`);

    const sitePages = routes.map((r) => ({
      route: r,
      dir: "cap-" + (r === "/" ? "home" : r.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")),
    }));

    await buildSite({
      origin: site,
      pages: sitePages,
      cwd: buildCwd,
      reportOut,
      concurrency,
    });
    break;
  }

  case "build-auto": {
    // node src/cli.ts build-auto --site <origin> [--mode core|full] [--out <report.html>] [--cwd <dir>] [--ugc-limit <n>] [--concurrency <n>] [--emit-events]
    const site = requireArg("site");
    const mode = (arg("mode", "core") as "core" | "full");
    const reportOut = arg("out");
    const buildCwd = arg("cwd", process.cwd());
    const ugcLimitStr = arg("ugc-limit");
    const ugcLimit = ugcLimitStr ? parseInt(ugcLimitStr, 10) : undefined;
    const concurrency = optPosIntArg("concurrency");
    const emitEvents = hasFlag("emit-events");
    const onEvent: EngineEventSink | undefined = emitEvents
      ? (e) => process.stdout.write(eventToJsonLine(e) + "\n")
      : undefined;

    await buildSiteAuto(site, {
      cwd: buildCwd,
      mode,
      reportOut,
      ugcLimit,
      concurrency,
      onEvent,
    });
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
    console.error("Valid subcommands: capture, label, project, build, build-site, build-auto, deploy");
    process.exit(1);
  }
}
