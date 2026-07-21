/**
 * Portability gate — proves the core invariant:
 * the same GymDocuments fixture renders through both templates,
 * both pass all objective gates, and both produce structurally
 * equivalent structured data (@graph).
 */
import { test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const RENDERER = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const GYM = path.resolve(RENDERER, "../../packages/schema/fixtures/iron-anchor.json");

// Each template builds to its own outDir to avoid clobbering the shared dist/
const DIST_MODERN = path.join(RENDERER, "dist-modern", "index.html");
const DIST_BLACKOUT = path.join(RENDERER, "dist-blackout", "index.html");

function build(template: string, outDir: string) {
  execFileSync("pnpm", ["run", "build"], {
    cwd: RENDERER,
    env: { ...process.env, GYM_JSON: GYM, TEMPLATE: template, OUT_DIR: outDir },
    stdio: "inherit",
  });
}

function parseGraph(html: string) {
  const blocks = [
    ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
  ].map((m) => JSON.parse(m[1].replace(/<\\\/script>/g, "</script>")));
  return blocks.find((b) => b["@graph"]);
}

beforeAll(() => {
  build("modern", "dist-modern");
  build("blackout", "dist-blackout");
}, 240_000);

// --- Both templates pass the head SEO gate ---

test("modern: head SEO gate passes", () => {
  const html = readFileSync(DIST_MODERN, "utf8");
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html).toMatch(/<meta name="description" content="[^"]+"/);
  expect(html).toMatch(/<link rel="canonical" href="[^"]+"/);
  expect(html).toMatch(/property="og:url"/);
  expect(html).toMatch(/name="twitter:card"/);
});

test("blackout: head SEO gate passes", () => {
  const html = readFileSync(DIST_BLACKOUT, "utf8");
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html).toMatch(/<meta name="description" content="[^"]+"/);
  expect(html).toMatch(/<link rel="canonical" href="[^"]+"/);
  expect(html).toMatch(/property="og:url"/);
  expect(html).toMatch(/name="twitter:card"/);
});

// --- Both produce equivalent @graph structured data ---

test("both templates produce identical @graph entity types", () => {
  const modernGraph = parseGraph(readFileSync(DIST_MODERN, "utf8"));
  const blackoutGraph = parseGraph(readFileSync(DIST_BLACKOUT, "utf8"));

  expect(modernGraph).toBeTruthy();
  expect(blackoutGraph).toBeTruthy();

  const types = (g: any) =>
    g["@graph"].map((n: any) => [n["@type"]].flat()).flat().sort();

  expect(types(modernGraph)).toEqual(types(blackoutGraph));
});

test("both templates produce identical LocalBusiness name, address, and type", () => {
  const modernGraph = parseGraph(readFileSync(DIST_MODERN, "utf8"));
  const blackoutGraph = parseGraph(readFileSync(DIST_BLACKOUT, "utf8"));

  const lb = (g: any) =>
    g["@graph"].find((n: any) =>
      Array.isArray(n["@type"]) ? n["@type"].includes("LocalBusiness") : n["@type"] === "LocalBusiness"
    );

  const mLb = lb(modernGraph);
  const bLb = lb(blackoutGraph);

  expect(mLb.name).toBe(bLb.name);
  expect(mLb.address?.addressLocality).toBe(bLb.address?.addressLocality);
  expect(mLb.telephone).toBe(bLb.telephone);
  expect(mLb["@type"]).toEqual(bLb["@type"]);
});

test("both templates produce identical FAQPage question count", () => {
  const modernGraph = parseGraph(readFileSync(DIST_MODERN, "utf8"));
  const blackoutGraph = parseGraph(readFileSync(DIST_BLACKOUT, "utf8"));

  const faq = (g: any) => g["@graph"].find((n: any) => n["@type"] === "FAQPage");

  expect(faq(modernGraph)?.mainEntity?.length).toBe(faq(blackoutGraph)?.mainEntity?.length);
});

test("both templates render the same page title", () => {
  const modernHtml = readFileSync(DIST_MODERN, "utf8");
  const blackoutHtml = readFileSync(DIST_BLACKOUT, "utf8");

  const title = (html: string) => html.match(/<title>([^<]+)<\/title>/)?.[1];
  expect(title(modernHtml)).toBe(title(blackoutHtml));
});
