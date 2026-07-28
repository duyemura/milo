#!/usr/bin/env node
/**
 * milo — operator CLI for the Milo v2 pipeline.
 *
 *   milo studio   --url <url> [--out <dir>]
 *   milo publish  staging    [--gym <path>] [--dist <path>]
 *   milo publish  production [--gym <path>]
 *   milo publish  rollback   --env staging|production [--version <id>] [--gym <path>]
 *   milo publish  status     [--gym <path>]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

function run(cmd: string, args: string[], cwd: string): number {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
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

  case "intake": {
    // intake has no subcommand — combine subcommand + rest so flags after "intake" are all visible
    const intakeArgs = subcommand ? [subcommand, ...rest] : rest;
    try {
      const url = requireFlag("url", intakeArgs);
      const outDir = path.resolve(flag("out", intakeArgs) ?? "./intake-output");
      const placesKey = process.env.GOOGLE_PLACES_API_KEY;
      if (!placesKey) { console.error("GOOGLE_PLACES_API_KEY is required for intake"); process.exit(1); }
      const openrouterKey = process.env.OPENROUTER_API_KEY;
      if (!openrouterKey) { console.error("OPENROUTER_API_KEY is required for intake"); process.exit(1); }

      const { runIntake, createRealPlacesClient, createRealPageFetcher } = await import("@milo/intake");
      const { chatCompletion } = await import("@milo/llm");
      const llmConfig = {
        provider: "openrouter" as const,
        openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
        openrouterApiKey: openrouterKey,
      };

      await runIntake({
        url,
        outDir,
        maxPages: Number(flag("max-pages", intakeArgs) ?? 25),
        includeUgc: intakeArgs.includes("--include-ugc"),
        concurrency: Number(flag("concurrency", intakeArgs) ?? 3),
        skipCrawl: intakeArgs.includes("--skip-crawl"),
        places: createRealPlacesClient(placesKey),
        fetcher: createRealPageFetcher(),
        chat: (o) => chatCompletion(o, llmConfig),
        capableModel: process.env.MILO_CAPABLE_MODEL ?? "anthropic/claude-opus-4-8",
        fastModel: process.env.MILO_FAST_MODEL ?? "anthropic/claude-haiku-4-5",
        discoveredAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  default: {
    console.log("Usage: milo <studio|publish|intake> [flags]");
    process.exit(command ? 1 : 0);
  }
}
