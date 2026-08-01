import path from "node:path";
import { spawn } from "node:child_process";
import type { AdminDb } from "../db/index.ts";
import type { AdminConfig } from "../config.ts";
import type { JobRow, SiteRow } from "../db/types.ts";
import { appendLog } from "./dispatch.ts";
import { runDeploy } from "./deploy.ts";

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
}): Promise<void> {
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
        throw new Error(
          "Clone seed is gated on the page-clone TypeScript engine port (see consolidation plan).",
        );
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
      await runDeploy({ db, config, job, site, distDir, gymJsonPath: path.join(seedDir, "gym.json"), log });
      return;
    }
  }
}
