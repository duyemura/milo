#!/usr/bin/env -S node --experimental-strip-types
/**
 * milo — operator CLI for the Milo v2 pipeline.
 *
 *   milo studio   --url <url> [--out <dir>]
 *   milo learn    --url <url> --name <gym-name> --city <city> --state <state> [--out <dir>] [--verbose]
 *   milo intake   --url <website-url> --name <gym-name> --city <city> --state <state> [--country <country>] [--out <dir>]
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

switch (command) {
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
    // learn has no subcommand — combine subcommand + rest so flags after "learn" are all visible
    const learnArgs = subcommand ? [subcommand, ...rest] : rest;
    try {
      const websiteUrl = requireFlag("url", learnArgs);
      if (!/^https?:\/\//i.test(websiteUrl)) {
        console.error("--url must be a valid http or https URL");
        process.exit(1);
      }
      const gymName = requireFlag("name", learnArgs);
      const city = requireFlag("city", learnArgs);
      const state = requireFlag("state", learnArgs);
      const country = flag("country", learnArgs) ?? "US";
      const outFlag = flag("out", learnArgs);
      const verbose = learnArgs.includes("--verbose");
      const placesKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!placesKey) { console.error("GOOGLE_PLACES_API_KEY is required for learn"); process.exit(1); }
      const openrouterKey = process.env.OPENROUTER_API_KEY;
      if (!openrouterKey) { console.error("OPENROUTER_API_KEY is required for learn"); process.exit(1); }

      const { runLearn, createRealPlacesClient, createRealPageFetcher, loadCrawlRules, verboseConsoleLogger } = await import("@milo/intake");
      const { chatCompletion } = await import("@milo/llm");
      const llmConfig = {
        provider: "openrouter" as const,
        openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        openrouterApiKey: openrouterKey,
      };

      const rulesPath = flag("rules", learnArgs);
      const result = await runLearn({
        url: websiteUrl,
        gymName,
        city,
        state,
        country,
        ...(outFlag ? { outDir: path.resolve(outFlag) } : {}),
        ...(verbose ? { logger: verboseConsoleLogger() } : {}),
        maxPages: Number(flag("max-pages", learnArgs) ?? 25),
        includeUgc: learnArgs.includes("--include-ugc"),
        concurrency: Number(flag("concurrency", learnArgs) ?? 3),
        skipCrawl: learnArgs.includes("--skip-crawl"),
        places: createRealPlacesClient(placesKey),
        fetcher: createRealPageFetcher(),
        chat: (o) => chatCompletion(o, llmConfig),
        capableModel: process.env.MILO_CAPABLE_MODEL ?? "anthropic/claude-sonnet-4-6",
        fastModel: process.env.MILO_FAST_MODEL ?? "google/gemini-2.5-flash",
        discoveredAt: new Date().toISOString(),
        ...(rulesPath ? { rules: loadCrawlRules(path.resolve(rulesPath)) } : {}),
      });
      console.log(`[learn] Done. ${result.pageDocs.length} pages documented. Docs at ${result.docsUri}`);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "intake": {
    // intake has no subcommand — combine subcommand + rest so flags after "intake" are all visible
    const intakeArgs = subcommand ? [subcommand, ...rest] : rest;
    try {
      const websiteUrl = requireFlag("url", intakeArgs);
      if (!/^https?:\/\//i.test(websiteUrl)) {
        console.error("--url must be a valid http or https URL");
        process.exit(1);
      }
      const gymName = requireFlag("name", intakeArgs);
      const city = requireFlag("city", intakeArgs);
      const state = requireFlag("state", intakeArgs);
      const country = flag("country", intakeArgs) ?? "US";
      const outDir = path.resolve(flag("out", intakeArgs) ?? "./intake-output");
      const placesKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!placesKey) { console.error("GOOGLE_PLACES_API_KEY is required for intake"); process.exit(1); }
      const openrouterKey = process.env.OPENROUTER_API_KEY;
      if (!openrouterKey) { console.error("OPENROUTER_API_KEY is required for intake"); process.exit(1); }

      const { runIntake, createRealPlacesClient, createRealPageFetcher, loadCrawlRules } = await import("@milo/intake");
      const { chatCompletion } = await import("@milo/llm");
      const llmConfig = {
        provider: "openrouter" as const,
        openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        openrouterApiKey: openrouterKey,
      };

      const rulesPath = flag("rules", intakeArgs);
      await runIntake({
        url: websiteUrl,
        gymName,
        city,
        state,
        country,
        outDir,
        maxPages: Number(flag("max-pages", intakeArgs) ?? 25),
        includeUgc: intakeArgs.includes("--include-ugc"),
        concurrency: Number(flag("concurrency", intakeArgs) ?? 3),
        skipCrawl: intakeArgs.includes("--skip-crawl"),
        places: createRealPlacesClient(placesKey),
        fetcher: createRealPageFetcher(),
        chat: (o) => chatCompletion(o, llmConfig),
        capableModel: process.env.MILO_CAPABLE_MODEL ?? "anthropic/claude-sonnet-4-6",
        fastModel: process.env.MILO_FAST_MODEL ?? "google/gemini-2.5-flash",
        discoveredAt: new Date().toISOString(),
        ...(rulesPath ? { rules: loadCrawlRules(path.resolve(rulesPath)) } : {}),
      });
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
      console.error(`gym.json not found at ${gymJsonPath}. Run \`milo intake\` or \`milo generate\` first.`);
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
      console.error("Usage: milo clone <url> [--template <id>] [--refresh-docs] [--deploy] [--out <dir>]");
      process.exit(1);
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
        const { slugFromUrl } = await import("@milo/storage");
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(deployOutAbs, { recursive: true });
        writeFileSync(publishJsonPath, JSON.stringify({ slug: slugFromUrl(cloneUrl), kvsArn }, null, 2) + "\n");
        console.log(`[clone] Created publish.json — slug: ${slugFromUrl(cloneUrl)}`);
      }
    }

    // --refresh-docs: run learn first, blocking, then proceed with clone
    if (cloneArgs.includes("--refresh-docs")) {
      const learnName = flag("name", cloneArgs);
      const learnCity = flag("city", cloneArgs);
      const learnState = flag("state", cloneArgs);
      if (!learnName || !learnCity || !learnState) {
        console.error("--refresh-docs requires --name, --city, and --state flags");
        process.exit(1);
      }
      const learnOut = path.resolve(flag("out", cloneArgs) ?? `./clone-output/${new URL(cloneUrl).hostname}`);
      const status = run("node", [
        fileURLToPath(import.meta.url),
        "learn",
        "--url", cloneUrl,
        "--name", learnName,
        "--city", learnCity,
        "--state", learnState,
        "--out", learnOut,
      ], ROOT);
      if (status !== 0) { console.error("[clone] learn step failed — aborting"); process.exit(status); }
    }

    const templateId = flag("template", cloneArgs);
    if (templateId) {
      // Template path: not yet implemented
      console.error("--template is not yet implemented. Run milo intake + milo generate + milo build for template builds.");
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

    // Pass through any extra flags (ugc-limit, concurrency, emit-events, etc.)
    // Strip flags we already handled so they don't get double-passed
    // Flags we've already processed — don't pass to the engine
    const handledFlags = new Set(["--refresh-docs", "--template", "--out", "--mode", "--name", "--city", "--state", "--url", "--deploy"]);
    // Boolean flags (no value argument follows them)
    const booleanFlags = new Set(["--refresh-docs", "--deploy"]);
    let i = 0;
    while (i < cloneArgs.length) {
      const arg = cloneArgs[i];
      if (handledFlags.has(arg)) {
        i += booleanFlags.has(arg) ? 1 : 2; // boolean flags don't consume a value
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
    console.log("Usage: milo <studio|learn|intake|generate|build|clone|publish> [flags]");
    process.exit(command ? 1 : 0);
  }
}
