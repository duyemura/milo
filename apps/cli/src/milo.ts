#!/usr/bin/env node
/**
 * milo — operator CLI for the Milo v2 pipeline.
 *
 *   milo build   --gym <gym.json> [--template <name>] [--out <dir>]
 *   milo preview [--gym <gym.json>] [--template <name>] [--port <n>]
 *   milo studio  --url <reference-url> [--out <dir>]
 *   milo docs                       regenerate template docs from manifests
 *   milo intake|publish|reskin      not yet implemented (see docs/specs)
 *
 * Builds stage only; production publish will always be an explicit,
 * human-approved action (spec: docs/specs/2026-07-19-milo-v2-rethink-design.md).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RENDERER = path.join(ROOT, "apps/renderer");
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
  case "build": {
    const gym = path.resolve(requireFlag("gym"));
    const template = flag("template") ?? "modern";
    if (!existsSync(gym)) {
      console.error(`gym.json not found: ${gym}`);
      process.exit(1);
    }
    const status = run("npx", ["astro", "build"], RENDERER, { GYM_JSON: gym, TEMPLATE: template });
    if (status !== 0) process.exit(status);
    const out = flag("out");
    if (out) {
      const dest = path.resolve(out);
      rmSync(dest, { recursive: true, force: true });
      cpSync(path.join(RENDERER, "dist"), dest, { recursive: true });
      console.log(`✓ site written to ${dest} (template: ${template})`);
    } else {
      console.log(`✓ site built at apps/renderer/dist (template: ${template})`);
    }
    process.exit(0);
  }
  case "preview": {
    const gym = path.resolve(flag("gym") ?? path.join(ROOT, "packages/schema/fixtures/iron-anchor.json"));
    const template = flag("template") ?? "modern";
    const port = flag("port") ?? "4321";
    process.exit(run("npx", ["astro", "preview", "--port", port], RENDERER, { GYM_JSON: gym, TEMPLATE: template }));
  }
  case "studio": {
    const url = requireFlag("url");
    const args = ["src/capture.mjs", "--url", url];
    const out = flag("out");
    if (out) args.push("--out", path.resolve(out));
    process.exit(run("node", args, STUDIO));
  }
  case "docs": {
    process.exit(run("node", ["src/template-docs.mjs"], STUDIO));
  }
  case "intake":
  case "publish":
  case "reskin": {
    console.log(
      `"${command}" is not implemented yet — it is specified in docs/specs/2026-07-19-milo-v2-rethink-design.md.\n` +
        (command === "reskin" ? `In the meantime: milo build --gym <path> --template <other-template>\n` : ""),
    );
    process.exit(2);
  }
  default: {
    console.log("Usage: milo <build|preview|studio|docs|intake|publish|reskin> [flags]");
    process.exit(command ? 1 : 0);
  }
}
