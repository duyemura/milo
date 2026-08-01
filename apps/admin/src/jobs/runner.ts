import path from "node:path";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { AdminDb } from "../db/index.ts";
import type { AdminConfig } from "../config.ts";
import type { JobRow, SiteRow } from "../db/types.ts";
import { appendLog } from "./dispatch.ts";
import { runDeploy } from "./deploy.ts";
import { runKeywordCycleJob, type BrainDeps } from "./keywordCycle.ts";
import { runMeasureJob, injectIntoDist, type MeasureDeps } from "./measure.ts";

export interface SpawnFn {
  (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{
    code: number;
    lines: string[];
  }>;
}

/** Real child-process spawn; streams lines via onLine. */
export const defaultSpawn: (
  onLine: (line: string) => void,
) => SpawnFn =
  (onLine) =>
  (cmd, args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { ...opts, env: { ...process.env, ...opts.env } });
      const lines: string[] = [];
      const collect = (buf: Buffer) => {
        for (const l of buf.toString("utf-8").split("\n")) {
          if (!l.trim()) continue;
          lines.push(l);
          onLine(l);
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, lines }));
    });

function siteDir(config: AdminConfig, siteId: string): string {
  return path.join(config.dataDir, "sites", siteId);
}

function miloArgs(config: AdminConfig): { cli: string; cwd: string } {
  return { cli: path.join(config.repoRoot, "apps/cli/src/milo.ts"), cwd: config.repoRoot };
}

/**
 * The engine command table. Admin spawns typed executables only (never imports engine
 * internals) — the A+B/CLI boundary from the spec. Each runner throws on non-zero exit.
 */
export async function runJob(opts: {
  db: AdminDb;
  config: AdminConfig;
  job: JobRow;
  site: SiteRow;
  spawn?: SpawnFn;
  brain?: BrainDeps;
  measure?: MeasureDeps;
}): Promise<string | void> {
  const { db, config, job, site } = opts;
  const log = async (line: string) => {
    await appendLog(db, job.id, line);
  };
  const sp = opts.spawn ?? defaultSpawn((l) => void appendLog(db, job.id, l));
  const payload = JSON.parse(job.payload) as Record<string, string>;
  const dir = siteDir(config, site.id);
  const seedDir = path.join(dir, "seed");
  const distDir = path.join(dir, "dist");
  const { cli, cwd } = miloArgs(config);

  const run = async (args: string[]) => {
    await log(`$ node apps/cli/src/milo.ts ${args.join(" ")}`);
    const r = await sp("node", [cli, ...args], { cwd, env: {} });
    if (r.code !== 0) throw new Error(`engine exited ${r.code}: ${args[0] ?? ""}`);
  };

  switch (job.type) {
    case "seed": {
      if (site.seedType === "clone") {
        const url = payload["sourceUrl"] ?? site.sourceUrl;
        if (!url) throw new Error("Clone seed requires sourceUrl.");
        await runCloneSeed({ db, config, job, site, url, seedDir, distDir, sp });
        return;
      }
      const url = payload["sourceUrl"] ?? site.sourceUrl;
      if (!url || !payload["name"] || !payload["city"] || !payload["state"]) {
        throw new Error("Template seed requires payload sourceUrl, name, city, state.");
      }
      await run([
        "intake",
        "--url", url,
        "--name", payload["name"],
        "--city", payload["city"],
        "--state", payload["state"],
        "--out", seedDir,
      ]);
      await run(["generate", "--docs", seedDir]);
      await db.updateTable("sites").set({ status: "seeded" }).where("id", "=", site.id).execute();
      await run([
        "build",
        "--gym", path.join(seedDir, "gym.json"),
        "--theme", payload["templateId"] ?? "modern",
        "--out", distDir,
      ]);
      const injS = await injectIntoDist({ db, site, distDir });
      if (injS.injected > 0) await log(`analytics injected into ${injS.injected}/${injS.files} html file(s)`);
      await db
        .updateTable("sites")
        .set({ status: "built", stage: "building" })
        .where("id", "=", site.id)
        .execute();
      return;
    }
    case "build": {
      await run(["generate", "--docs", seedDir]);
      await run([
        "build",
        "--gym", path.join(seedDir, "gym.json"),
        "--theme", payload["templateId"] ?? "modern",
        "--out", distDir,
      ]);
      const inj = await injectIntoDist({ db, site, distDir });
      if (inj.injected > 0) await log(`analytics injected into ${inj.injected}/${inj.files} html file(s)`);
      await db
        .updateTable("sites")
        .set({ status: "built", stage: "building" })
        .where("id", "=", site.id)
        .execute();
      return;
    }
    case "deploy-staging":
    case "promote":
    case "rollback": {
      await runDeploy({ db, config, job, site, distDir, gymJsonPath: path.join(seedDir, "gym.json"), log, sp });
      return;
    }
    case "keyword-cycle": {
      return await runKeywordCycleJob({ db, config, job, site, brain: opts.brain ?? { chat: null } });
    }
    case "measure": {
      return await runMeasureJob({ db, config, job, site, deps: opts.measure });
    }
  }
}

/**
 * Clone seed: capture → project → astro build, via the typed @milo/clone-engine CLI.
 * Deploy of clone builds goes through the same CLI (see jobs/deploy.ts); a live
 * staging deploy is a human-authorized action (per the engine's own doc note).
 */
async function runCloneSeed(opts: {
  db: AdminDb;
  config: AdminConfig;
  job: JobRow;
  site: SiteRow;
  url: string;
  seedDir: string;
  distDir: string;
  sp: SpawnFn;
}): Promise<void> {
  const { db, config, job, site, url, seedDir, distDir } = opts;
  const log = async (line: string) => appendLog(db, job.id, line);
  const cloneCli = path.join(config.repoRoot, "packages/clone-engine/src/cli.ts");
  const captureOut = path.join(seedDir, "capture");
  const projOut = path.join(seedDir, "project");
  const cwd = config.repoRoot;

  await log(`$ node packages/clone-engine/src/cli.ts capture --url ${url} --out capture/`);
  const cap = await opts.sp("node", [cloneCli, "capture", "--url", url, "--out", captureOut], { cwd, env: {} });
  if (cap.code !== 0) throw new Error(`clone capture exited ${cap.code}`);
  if (!fs.existsSync(path.join(captureOut, "capture.json"))) {
    throw new Error("clone capture produced no capture.json — engine contract violated");
  }

  await log(`$ node packages/clone-engine/src/cli.ts project --dir capture/ --out project/`);
  const proj = await opts.sp("node", [cloneCli, "project", "--dir", captureOut, "--out", projOut, "--base", ""], {
    cwd,
    env: {},
  });
  if (proj.code !== 0) throw new Error(`clone project exited ${proj.code}`);
  await db.updateTable("sites").set({ status: "seeded", stage: "building" }).where("id", "=", site.id).execute();

  // Astro build: project() emits <out>/astro; link the shared toolchain and build.
  const astroDir = path.join(projOut, "astro");
  const toolchain = path.join(config.repoRoot, "page-clone-spike/out-project-page/astro/node_modules");
  const linkPath = path.join(astroDir, "node_modules");
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(toolchain, linkPath, "dir");
  await log(`$ astro build (project/astro)`);
  const astroBin = path.join(toolchain, ".bin", "astro");
  const ast = await opts.sp(astroBin, ["build"], { cwd: astroDir, env: {} });
  if (ast.code !== 0) throw new Error(`astro build exited ${ast.code}`);

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.cpSync(path.join(astroDir, "dist"), distDir, { recursive: true });
  const inj = await injectIntoDist({ db, site, distDir });
  if (inj.injected > 0) await appendLog(db, job.id, `analytics injected into ${inj.injected}/${inj.files} html file(s)`);
  await db.updateTable("sites").set({ status: "built", stage: "building" }).where("id", "=", site.id).execute();
}
