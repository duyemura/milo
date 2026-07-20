#!/usr/bin/env node
/**
 * milo — operator CLI for the Milo v2 pipeline.
 *
 *   milo studio  --url <reference-url> [--out <dir>]   capture a live site into a bundle
 *   milo intake|publish             not yet implemented (see docs/specs)
 *
 * The template-render commands (build/preview) were removed with the
 * hand-authored templates; the Template IR renderer is Phase 1
 * (spec: docs/superpowers/specs/2026-07-20-template-ir-design.md).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STUDIO = path.join(ROOT, "apps/studio");

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): number {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  return result.status ?? 1;
}

function requireFlag(name: string): string {
  const v = flag(name);
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(1);
  }
  return v;
}

switch (command) {
  case "studio": {
    const url = requireFlag("url");
    const args = ["src/capture.mjs", "--url", url];
    const out = flag("out");
    if (out) args.push("--out", path.resolve(out));
    process.exit(run("node", args, STUDIO));
  }
  case "intake":
  case "publish": {
    console.log(
      `"${command}" is not implemented yet — it is specified in docs/specs/2026-07-19-milo-v2-rethink-design.md.`,
    );
    process.exit(2);
  }
  default: {
    console.log("Usage: milo <studio|intake|publish> [flags]");
    process.exit(command ? 1 : 0);
  }
}
