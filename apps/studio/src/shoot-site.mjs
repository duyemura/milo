#!/usr/bin/env node
/**
 * Shoot a built Milo site for visual verification.
 * Builds the requested template first (so preview serves the right dist),
 * then serves it and captures full-page screenshots of every page at
 * desktop (1440) and mobile (375).
 *
 * Usage: node src/shoot-site.mjs --gym <gym.json> --template <name> --out <dir>
 */
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RENDERER = path.join(ROOT, "apps/renderer");
const gym = path.resolve(flag("gym") ?? path.join(ROOT, "packages/schema/fixtures/iron-anchor.json"));
const template = flag("template") ?? "modern";
const OUT = path.resolve(flag("out") ?? `shots/${template}`);
fs.mkdirSync(OUT, { recursive: true });

const build = spawnSync("npx", ["astro", "build"], {
  cwd: RENDERER,
  stdio: "pipe",
  env: { ...process.env, GYM_JSON: gym, TEMPLATE: template },
});
if (build.status !== 0) {
  console.error(build.stdout?.toString(), build.stderr?.toString());
  process.exit(build.status ?? 1);
}

const gymJson = JSON.parse(fs.readFileSync(gym, "utf8"));
const slugs = gymJson.pages.map((p) => (p.slug === "home" ? "" : p.slug));

const server = spawn("npx", ["astro", "preview", "--port", "4399"], {
  cwd: RENDERER,
  stdio: "pipe",
  env: { ...process.env, GYM_JSON: gym, TEMPLATE: template },
});
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch("http://localhost:4399/");
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch();
for (const vp of [
  { w: 1440, name: "d" },
  { w: 375, name: "m" },
]) {
  const page = await browser.newPage({ viewport: { width: vp.w, height: 1000 } });
  for (const slug of slugs) {
    await page.goto(`http://localhost:4399/${slug}`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/${vp.name}-${slug || "home"}.png`, fullPage: true });
  }
  await page.close();
}
console.log(JSON.stringify({ template, out: OUT, shots: fs.readdirSync(OUT).length }));
await browser.close();
server.kill();
process.exit(0);
