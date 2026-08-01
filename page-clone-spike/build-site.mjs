// Whole-site orchestrator: capture → project(base+links) → astro build → assemble into full-site/.
import { execSync } from "node:child_process";
import fs from "node:fs"; import path from "node:path";
const O = "https://speakeasyofstrength.com";
const PAGES = [
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
PAGES.forEach((p) => { p.url = O + p.route; p.out = p.route === "/" ? "sp-home" : "sp-" + p.route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""); });
const run = (cmd, cwd) => execSync(cmd, { cwd: cwd || process.cwd(), stdio: "inherit", shell: "/bin/bash" });

// full internal link map (both slash forms) so nav rewrites everywhere
const links = {};
for (const p of PAGES) { links[p.url] = p.route; links[p.url.replace(/\/$/, "")] = p.route; }
fs.writeFileSync("links-site.json", JSON.stringify(links, null, 1));

const ok = [];
for (const p of PAGES) {
  try {
    if (!fs.existsSync(path.join(p.dir, "capture.json"))) { console.log(`\n=== CAPTURE ${p.route} ===`); run(`node page-clone.mjs --url ${p.url} --out ${p.dir} --no-verify`); }
    else console.log(`\n=== capture cached ${p.route} ===`);
    const base = p.route === "/" ? "" : p.route.replace(/\/$/, "");
    console.log(`=== PROJECT ${p.route} (base='${base}') ===`);
    run(`node project-page.mjs --dir ${p.dir} --out ${p.out} --base "${base}" --links links-site.json --no-diff`);
    run(`ln -sf ../../out-project-page/astro/node_modules node_modules && ./node_modules/.bin/astro build`, path.join(p.out, "astro"));
    ok.push(p);
  } catch (e) { console.log(`!!! FAILED ${p.route}: ${e.message.split("\n")[0]}`); }
}

fs.rmSync("full-site", { recursive: true, force: true }); fs.mkdirSync("full-site");
for (const p of ok) {
  const dest = p.route === "/" ? "full-site" : path.join("full-site", p.route.replace(/^\/|\/$/g, ""));
  fs.mkdirSync(dest, { recursive: true });
  run(`cp -R ${path.join(p.out, "astro/dist")}/. ${dest}/`);
}
console.log(`\n✓ assembled full-site/ with ${ok.length}/${PAGES.length} pages: ${ok.map((p) => p.route).join("  ")}`);
