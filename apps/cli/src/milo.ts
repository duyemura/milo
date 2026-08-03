#!/usr/bin/env -S node --experimental-transform-types --env-file-if-exists=.env
/**
 * milo — operator CLI for the Milo v2 pipeline.
 *
 *   milo studio   --url <url> [--out <dir>]
 *   milo learn    <url> [--name <name>] [--city <city>] [--state <state>] [--out <dir>] [--verbose]
 *   milo generate --docs <dir> [--out <dir>]
 *   milo build      --gym <path> [--theme modern|blackout] [--site-url <url>] [--out <dir>]
 *   milo publish  staging    [--gym <path>] [--dist <path>]
 *   milo publish  production [--gym <path>]
 *   milo publish  rollback   --env staging|production [--version <id>] [--gym <path>]
 *   milo publish  status     [--gym <path>]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import "@aws-sdk/signature-v4-crt"; // Load SigV4a signer before CloudFront KVS client
import { runGenerate } from "./generate.ts";
import {
  resolveOrInitConfig,
  publishStaging,
  publishProduction,
  publishStatus,
  publishRollback,
  createRealS3Adapter,
  createRealKvsAdapter,
} from "@milo/publish";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STUDIO = path.join(ROOT, "apps/studio");
const RENDERER_DIST = path.join(ROOT, "apps/renderer/dist");

const [command, subcommand, ...rest] = process.argv.slice(2);

const flag = (name: string, args = rest): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

function requireFlag(name: string, args = rest): string {
  const v = flag(name, args);
  if (!v) { console.error(`--${name} is required`); process.exit(1); }
  return v;
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): number {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: env ?? process.env });
  return result.status ?? 1;
}

async function resolvePublishConfig() {
  return resolveOrInitConfig({
    gymJsonPath: flag("gym") ?? "./gym.json",
    kvsArnOverride: flag("kvs-arn"),
    bucketOverride: flag("bucket"),
    regionOverride: flag("region"),
    siteDomainOverride: flag("domain"),
    awsProfileOverride: flag("profile"),
  });
}

const HELP: Record<string, string> = {
  studio: `
  milo studio --url <url> [--out <dir>]

  Capture a website screenshot/snapshot for reference.

  --url <url>    Website to capture (required)
  --out <dir>    Output directory (default: ./studio-output)
`.trim(),

  learn: `
  milo learn <url> [options]

  Crawl a gym's website and produce structured page docs (the "learn" phase).
  Output is a directory of JSON docs used by \`milo clone\` or \`milo generate\`.

  <url>                Gym website URL (required; or use --url <url>)
  --name <name>        Gym name for GMB lookup (default: hostname)
  --city <city>        City hint for GMB lookup (optional)
  --state <state>      State hint for GMB lookup (optional)
  --country <country>  Country code (default: US)
  --out <dir>          Output directory (default: storage backend)
  --concurrency <n>    Parallel page fetchers (default: 3)
  --verbose            Stream LLM reasoning to stderr
`.trim(),

  generate: `
  milo generate --docs <dir> [--out <dir>]

  Generate gym.json from a learn docs directory.

  --docs <dir>   Input docs directory from \`milo learn\` (default: ./intake-output)
  --out <dir>    Output directory for gym.json (default: same as --docs)
`.trim(),

  build: `
  milo build [--gym <path>] [options]

  Build a static site from a gym.json file using the renderer.

  --gym <path>       Path to gym.json (default: ./gym.json)
  --theme <id>       Theme: modern | blackout (default: modern)
  --site-url <url>   Public site URL baked into the build (default: https://example.com)
  --out <dir>        Output directory for the built site (default: apps/renderer/dist)
`.trim(),

  clone: `
  milo clone <url> [options]

  DOM-clone a live gym website. Automatically runs \`milo learn\` first if no
  learn docs are found for this URL.

  <url>          Website to clone (required)
  --out <dir>    Output directory (also used as deploy root with --deploy)
  --mode <mode>  Clone mode: core | full (default: core)
  --deploy       Publish the built site to staging after a successful build
                 Requires --out and CLOUDFRONT_KVS_ARN env var on first run
`.trim(),

  publish: `
  milo publish <staging|production|rollback|status> [options]

  Deploy a built site to CloudFront / manage publish state.

  milo publish staging    [--gym <path>] [--dist <path>]   Push dist to staging
  milo publish production [--gym <path>]                    Promote staging → production
  milo publish rollback   --env <staging|production> [--version <id>]  Roll back
  milo publish status     [--gym <path>]                    Show publish history

  --gym <path>       Path to gym.json (default: ./gym.json)
  --dist <path>      Path to built dist dir (default: apps/renderer/dist)
  --env <env>        Environment to roll back: staging | production
  --version <id>     Specific version to roll back to (default: previous)
  --kvs-arn <arn>    Override KVS ARN
  --bucket <name>    Override S3 bucket
  --region <region>  Override AWS region
  --profile <name>   AWS profile to use
`.trim(),
};

function printHelp(cmd?: string) {
  if (cmd && HELP[cmd]) {
    console.log(HELP[cmd]);
  } else if (cmd) {
    console.error(`Unknown command: ${cmd}`);
    console.error(`Available: ${Object.keys(HELP).join(", ")}`);
    process.exit(1);
  } else {
    console.log(`
milo — site-building CLI

Usage: milo <command> [options]

Commands:
  learn      Learn about a business from its website (GMB, brand, ICP, tone)
  clone      DOM-clone a live website (auto-runs learn if no docs found)
  build      Build a static site from gym.json
  generate   Generate gym.json from learn docs
  publish    Deploy a built site to staging or production
  studio     Capture a website snapshot

Run \`milo help <command>\` for details on any command.
`.trim());
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const helpTarget = command && !command.startsWith("-") ? command : undefined;
  printHelp(helpTarget);
  process.exit(0);
}

switch (command) {
  case "help": {
    printHelp(subcommand);
    process.exit(0);
  }
  case "studio": {
    const url = requireFlag("url", rest);
    const args = ["src/capture.mjs", "--url", url];
    const out = flag("out", rest);
    if (out) args.push("--out", path.resolve(out));
    process.exit(run("node", args, STUDIO));
  }

  case "publish": {
    try {
      const config = await resolvePublishConfig();
      const s3 = createRealS3Adapter({ bucket: config.bucket, region: config.region, awsProfile: config.awsProfile });
      const kvs = createRealKvsAdapter({ kvsArn: config.kvsArn, region: config.region, awsProfile: config.awsProfile });

      switch (subcommand) {
      case "staging": {
        const distDir = flag("dist") ?? RENDERER_DIST;
        await publishStaging({ config, distDir, s3, kvs });
        break;
      }
      case "production": {
        await publishProduction({ config, s3, kvs });
        break;
      }
      case "rollback": {
        const env = requireFlag("env") as "staging" | "production";
        if (env !== "staging" && env !== "production") {
          console.error("--env must be staging or production");
          process.exit(1);
        }
        await publishRollback({ config, env, versionId: flag("version"), s3, kvs });
        break;
      }
      case "status": {
        const result = await publishStatus({ config, s3 });
        if (!result) console.log("No publish history found for this gym.");
        break;
      }
      default: {
        console.log("Usage: milo publish <staging|production|rollback|status> [flags]");
        process.exit(subcommand ? 1 : 0);
      }
    }
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "learn": {
    // Accept positional URL: `milo learn <url> [flags]` or legacy `milo learn --url <url>`
    const learnArgs = subcommand && !subcommand.startsWith("--") ? rest : (subcommand ? [subcommand, ...rest] : rest);
    const positionalUrl = subcommand && /^https?:\/\//i.test(subcommand) ? subcommand : undefined;
    try {
      const websiteUrl = positionalUrl ?? requireFlag("url", learnArgs);
      if (!/^https?:\/\//i.test(websiteUrl)) {
        console.error("--url must be a valid http or https URL");
        process.exit(1);
      }
      const hostname = new URL(websiteUrl).hostname.replace(/^www\./, "");
      const gymName = flag("name", learnArgs) ?? hostname;
      const city = flag("city", learnArgs) ?? "";
      const state = flag("state", learnArgs) ?? "";
      const country = flag("country", learnArgs) ?? "US";
      const outFlag = flag("out", learnArgs);
      const verbose = learnArgs.includes("--verbose");
      const placesKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!placesKey) { console.error("GOOGLE_PLACES_API_KEY is required for learn"); process.exit(1); }
      const openrouterKey = process.env.OPENROUTER_API_KEY;
      if (!openrouterKey) { console.error("OPENROUTER_API_KEY is required for learn"); process.exit(1); }

      const { runLearn, createRealPlacesClient, createRealPageFetcher, verboseConsoleLogger } = await import("@milo/intake");
      const { chatCompletion } = await import("@milo/llm");
      const llmConfig = {
        provider: "openrouter" as const,
        openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        openrouterApiKey: openrouterKey,
      };

      const result = await runLearn({
        url: websiteUrl,
        gymName,
        city,
        state,
        country,
        ...(outFlag ? { outDir: path.resolve(outFlag) } : {}),
        ...(verbose ? { logger: verboseConsoleLogger() } : {}),
        concurrency: Number(flag("concurrency", learnArgs) ?? 3),
        places: createRealPlacesClient(placesKey),
        fetcher: createRealPageFetcher(),
        chat: (o) => chatCompletion(o, llmConfig),
        capableModel: process.env.MILO_CAPABLE_MODEL ?? "anthropic/claude-sonnet-4-6",
        fastModel: process.env.MILO_FAST_MODEL ?? "google/gemini-2.5-flash",
        discoveredAt: new Date().toISOString(),
      });
      console.log(`[learn] Done. Docs at ${result.docsUri}`);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "generate": {
    const generateArgs = subcommand ? [subcommand, ...rest] : rest;
    const docsDir = path.resolve(flag("docs", generateArgs) ?? "./intake-output");
    const outDir = path.resolve(flag("out", generateArgs) ?? docsDir);
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) { console.error("OPENROUTER_API_KEY is required for generate"); process.exit(1); }

    try {
      const { chatCompletion } = await import("@milo/llm");
      const llmConfig = {
        provider: "openrouter" as const,
        openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        openrouterApiKey: openrouterKey,
      };

      await runGenerate({
        docsDir,
        outDir,
        chat: (o) => chatCompletion(o, llmConfig),
        model: process.env.MILO_CAPABLE_MODEL ?? "anthropic/claude-sonnet-4-6",
      });
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "build": {
    const buildArgs = subcommand ? [subcommand, ...rest] : rest;
    const gymJsonPath = path.resolve(flag("gym", buildArgs) ?? "./gym.json");
    if (!existsSync(gymJsonPath)) {
      console.error(`gym.json not found at ${gymJsonPath}. Run \`milo generate\` first.`);
      process.exit(1);
    }
    const template = flag("theme", buildArgs) ?? process.env.TEMPLATE ?? "modern";
    const siteUrl = flag("site-url", buildArgs) ?? process.env.SITE_URL ?? "https://example.com";
    const outDir = path.resolve(flag("out", buildArgs) ?? process.env.OUT_DIR ?? RENDERER_DIST);
    const rendererRoot = path.join(ROOT, "apps/renderer");
    const env = {
      ...process.env,
      GYM_JSON: gymJsonPath,
      TEMPLATE: template,
      SITE_URL: siteUrl,
      OUT_DIR: outDir,
    };
    console.log(`[milo] Building renderer for ${gymJsonPath} (theme: ${template})`);
    const status = run("pnpm", ["--filter", "renderer", "build"], rendererRoot, env);
    if (status !== 0) process.exit(status);

    const gymAssetsDir = path.join(path.dirname(gymJsonPath), "assets");
    if (existsSync(gymAssetsDir)) {
      const distAssetsDir = path.join(outDir, "assets");
      await mkdir(distAssetsDir, { recursive: true });
      await cp(gymAssetsDir, distAssetsDir, { recursive: true, force: true });
      console.log(`[milo] Copied assets from ${gymAssetsDir} to ${distAssetsDir}`);
    }

    console.log(`[milo] Renderer dist ready at ${outDir}`);
    break;
  }

  case "clone": {
    // subcommand holds the URL when invoked as: milo clone <url> [flags]
    const cloneUrl = subcommand;
    const cloneArgs = rest;
    if (!cloneUrl || !/^https?:\/\//i.test(cloneUrl)) {
      console.error("Usage: milo clone <url> [--mode <core|full>] [--deploy] [--out <dir>]");
      process.exit(1);
    }

    // Auto-run learn if no docs are present for this URL
    const { getStorage, slugFromUrl } = await import("@milo/storage");
    const slug = slugFromUrl(cloneUrl);
    const hasLearnDocs = await getStorage().exists(`gyms/${slug}/docs/identity.json`);
    if (!hasLearnDocs) {
      console.log(`[clone] No learn docs found for ${cloneUrl} — running \`milo learn\` first…`);
      const learnStatus = run("node", [fileURLToPath(import.meta.url), "learn", "--url", cloneUrl], ROOT);
      if (learnStatus !== 0) { console.error("[clone] learn step failed — aborting"); process.exit(learnStatus); }
    }

    // --deploy: opt-in staging publish after a successful build. Validate config
    // BEFORE building so a missing KVS ARN fails in seconds, not after a 5-min build.
    const deploy = cloneArgs.includes("--deploy");
    let deployOutAbs: string | null = null;
    if (deploy) {
      const out = flag("out", cloneArgs);
      if (!out) {
        console.error("--deploy requires --out <dir> so the built site location is known");
        process.exit(1);
      }
      deployOutAbs = path.resolve(out);
      const publishJsonPath = path.join(deployOutAbs, "publish.json");
      if (!existsSync(publishJsonPath)) {
        const kvsArn = process.env.CLOUDFRONT_KVS_ARN;
        if (!kvsArn) {
          console.error("--deploy: CLOUDFRONT_KVS_ARN is required on first deploy (or place a publish.json in --out)");
          process.exit(1);
        }
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(deployOutAbs, { recursive: true });
        writeFileSync(publishJsonPath, JSON.stringify({ slug, kvsArn }, null, 2) + "\n");
        console.log(`[clone] Created publish.json — slug: ${slug}`);
      }
    }

    const templateId = flag("template", cloneArgs);
    if (templateId) {
      console.error("--template is not yet implemented. Run milo learn + milo generate + milo build for template builds.");
      process.exit(1);
    }

    // DOM clone path: subprocess to the existing clone-engine CLI
    const cloneCli = path.join(ROOT, "packages/clone-engine/src/cli.ts");
    const outDir = flag("out", cloneArgs);
    const mode = flag("mode", cloneArgs) ?? "core";
    const engineArgs = [
      cloneCli,
      "build-auto",
      "--site", cloneUrl,
      "--mode", mode,
    ];
    if (outDir) engineArgs.push("--cwd", path.resolve(outDir));

    // Pass through extra flags; strip ones already handled
    const handledFlags = new Set(["--template", "--out", "--mode", "--deploy"]);
    const booleanFlags = new Set(["--deploy"]);
    let i = 0;
    while (i < cloneArgs.length) {
      const arg = cloneArgs[i];
      if (handledFlags.has(arg)) {
        i += booleanFlags.has(arg) ? 1 : 2;
      } else if (arg.startsWith("--")) {
        engineArgs.push(arg);
        if (i + 1 < cloneArgs.length && !cloneArgs[i + 1].startsWith("--")) {
          engineArgs.push(cloneArgs[i + 1]);
          i += 2;
        } else {
          i += 1;
        }
      } else {
        i += 1;
      }
    }

    const buildStatus = run("node", engineArgs, ROOT);
    if (buildStatus !== 0) process.exit(buildStatus);

    if (deployOutAbs) {
      try {
        const config = await resolveOrInitConfig({ gymJsonPath: path.join(deployOutAbs, "gym.json") });
        const s3 = createRealS3Adapter({ bucket: config.bucket, region: config.region, awsProfile: config.awsProfile });
        const kvs = createRealKvsAdapter({ kvsArn: config.kvsArn, region: config.region, awsProfile: config.awsProfile });
        await publishStaging({ config, distDir: path.join(deployOutAbs, "full-site"), s3, kvs });
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
    process.exit(0);
  }

  default: {
    console.log("Usage: milo <learn|clone|generate|build|publish|studio> [flags]");
    process.exit(command ? 1 : 0);
  }
}
