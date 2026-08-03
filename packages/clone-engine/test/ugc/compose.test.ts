import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { project } from "../../src/project.ts";
import { composePage } from "../../src/ugc/compose.ts";
import { BLUEPRINTS, routeOf } from "../../src/ugc/blueprints.ts";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../../src/edit/types.ts";
import type { SiteManifest } from "../../src/types.ts";
import { findAstroModules } from "../helpers/astro.ts";

function editableHash(siteDir: string): string {
  const files: string[] = [];
  const walk = (abs: string, rel: string) => {
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const c of fs.readdirSync(abs).sort()) walk(path.join(abs, c), path.join(rel, c));
    else files.push(rel);
  };
  const push = (rel: string) => walk(path.join(siteDir, rel), rel);
  push("site.json");
  push(path.join("astro", "brand.json"));
  push(path.join("astro", "src"));
  push(path.join("astro", "public", "assets"));
  push("assets");
  const h = crypto.createHash("sha256");
  for (const rel of files.sort()) { h.update(rel); h.update("\0"); h.update(fs.readFileSync(path.join(siteDir, rel))); h.update("\0"); }
  return h.digest("hex");
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../..");
const REPO = path.resolve(PKG, "../../..");  // /Users/dan/pushpress
const GOLDEN = path.join(PKG, "test/golden/speakeasy");
const WIDTH = 1440;
const MODEL = "mock-model";


const ASTRO_MODULES = findAstroModules();

function fakeChat(responses: string[]): ChatFn {
  let i = 0;
  return async () => ({ content: responses[Math.min(i++, responses.length - 1)] });
}

async function projectFixture(prefix: string): Promise<{ out: string; site: SiteRef }> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await project({ dir: GOLDEN, out, trim: true, noDiff: true });
  return { out, site: { dir: out } };
}

function copyFillFor(role: string): Record<string, unknown> {
  switch (role) {
    case "hero": return { eyebrow: "", headline: "Best CrossFit in Brooklyn", subcopy: "Beginner-friendly coaching.", primaryCta: "Book a free class" };
    case "content-block": return { heading: "Why It Works", body: "Structured, scalable workouts for every level.", cta: "Learn more" };
    case "media-block": return { eyebrow: "", heading: "See It In Action", body: "A look inside a typical class.", cta: "Watch" };
    case "feature-grid": return { heading: "What You Get", features: [{ title: "Coaching", body: "Certified coaches every session." }, { title: "Community", body: "Train with people who push you." }, { title: "Schedule", body: "Classes morning to night." }] };
    case "faq": return { heading: "Questions", items: [{ question: "Do I need experience?", answer: "No — every workout scales to you." }, { question: "What should I bring?", answer: "Just water and a good attitude." }, { question: "How long is a class?", answer: "About an hour, warm-up to cool-down." }, { question: "Is there parking?", answer: "Yes, free street and lot parking." }, { question: "Can I try before joining?", answer: "Your first class is free." }, { question: "What are the hours?", answer: "Open early morning through evening, 7 days." }] };
    case "cta-band": return { eyebrow: "Ready?", headline: "Start This Week", subcopy: "Your first class is free.", buttonLabel: "Book now" };
    case "stats-band": return { items: [{ number: "500+", label: "Members" }, { number: "12", label: "Coaches" }, { number: "7", label: "Days a week" }, { number: "4.9", label: "Avg rating" }] };
    case "lead-form": return { heading: "Join The Challenge", subcopy: "Sign up in seconds.", placeholder: "Your email", cta: "Sign up" };
    default: return {};
  }
}

function composeQueue(kind: keyof typeof BLUEPRINTS, meta: { title: string; description: string }): string[] {
  const roles = BLUEPRINTS[kind];
  const outline = { sectionBriefs: roles.map((r, i) => `Coherent brief ${i} for ${r}.`) };
  return [JSON.stringify(outline), ...roles.map((r) => JSON.stringify(copyFillFor(r))), JSON.stringify(meta)];
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { if (browser) await browser.close(); });
const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("composePage — UGC content page creation", () => {
  it("composes a blog page: blueprint sections in order, SEO meta, nav link, homepage untouched", async () => {
    const { out, site } = await projectFixture("compose-blog-");
    cleanup.add(out);
    const META = { title: "Best CrossFit Gym in Brooklyn for Beginners", description: "New to CrossFit? Our Brooklyn gym coaches beginners from day one. Book a free class." };
    const chat = fakeChat(composeQueue("blog", META));
    const manifestBefore = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const homeSectionsBefore = manifestBefore.pages.find((p) => p.route === "/")!.sections.length;

    const result = await composePage(site, { route: "/blog/best-crossfit-brooklyn/", kind: "blog", brief: "Best CrossFit gym in Brooklyn for beginners", addToNav: true, navText: "Blog" }, chat, MODEL, browser, { width: WIDTH });

    expect(result.ok, `compose failed: ${result.failures.join(" | ")}`).toBe(true);
    const route = routeOf("/blog/best-crossfit-brooklyn/");
    expect(result.route).toBe(route);
    expect(result.sections.length).toBe(BLUEPRINTS.blog.length);

    const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const page = manifest.pages.find((p) => p.route === route);
    expect(page, "composed page must be in site.json").toBeTruthy();
    expect(page!.sections.map((s) => s.role)).toEqual(BLUEPRINTS.blog);
    expect(manifest.pages.find((p) => p.route === "/")!.sections.length).toBe(homeSectionsBefore);

    const slug = route.replace(/^\/|\/$/g, "");
    const astro = fs.readFileSync(path.join(out, "astro/src/pages", `${slug}.astro`), "utf8");
    for (const name of result.sections) expect(astro, `page astro must include ${name}`).toContain(`<${name} />`);
    expect(astro).toContain(`<title>${META.title}</title>`);
    expect(astro).toContain(META.description);

    const navSection = manifest.pages.flatMap((p) => p.sections).find((s) => s.role === "navbar" || /nav/i.test(s.name));
    expect(navSection, "a nav section must exist").toBeTruthy();
    const navSrc = fs.readFileSync(path.join(out, navSection!.file), "utf8");
    expect(navSrc).toContain(`href="${route}"`);
  }, 600_000);

  it("composes a local-seo page (different blueprint: feature-grid + faq)", async () => {
    const { out, site } = await projectFixture("compose-seo-");
    cleanup.add(out);
    const META = { title: "CrossFit Gym Near Park Slope", description: "The top-rated CrossFit gym serving Park Slope. Coaching, community, and classes all day." };
    const chat = fakeChat(composeQueue("local-seo", META));

    const result = await composePage(site, { route: "/gyms/park-slope/", kind: "local-seo", brief: "CrossFit gym serving Park Slope, Brooklyn" }, chat, MODEL, browser, { width: WIDTH });

    expect(result.ok, `compose failed: ${result.failures.join(" | ")}`).toBe(true);
    const route = routeOf("/gyms/park-slope/");
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    const page = manifest.pages.find((p) => p.route === route)!;
    expect(page.sections.map((s) => s.role)).toEqual(BLUEPRINTS["local-seo"]);
    const navSection = manifest.pages.flatMap((p) => p.sections).find((s) => s.role === "navbar" || /nav/i.test(s.name))!;
    const navSrc = fs.readFileSync(path.join(out, navSection.file), "utf8");
    expect(navSrc).not.toContain(`href="${route}"`);
  }, 600_000);

  it("a failed compose leaves the site BYTE-IDENTICAL (atomic rollback)", async () => {
    const { out, site } = await projectFixture("compose-fail-");
    cleanup.add(out);
    const beforeHash = editableHash(out);

    const chat = fakeChat([
      JSON.stringify({ sectionBriefs: ["a", "b", "c", "d", "e"] }),
      "NOT VALID JSON — force the first section to fail",
    ]);

    const result = await composePage(site, { route: "/blog/doomed/", kind: "blog", brief: "This compose must fail and roll back" }, chat, MODEL, browser, { width: WIDTH });

    expect(result.ok, "a failing compose must report ok:false").toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(editableHash(out), "a failed compose must leave the site byte-identical").toBe(beforeHash);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "site.json"), "utf8")) as SiteManifest;
    expect(manifest.pages.some((p) => p.route === routeOf("/blog/doomed/"))).toBe(false);
  }, 600_000);
});
