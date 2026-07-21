import { test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import path from "node:path";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";

const RENDERER = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(RENDERER, "dist");
const GYM = path.resolve(RENDERER, "../../packages/schema/fixtures/iron-anchor.json");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

let server: ReturnType<typeof createServer>;
let port: number;
let chrome: Awaited<ReturnType<typeof launch>>;

beforeAll(async () => {
  execFileSync("pnpm", ["build"], {
    cwd: RENDERER,
    env: { ...process.env, GYM_JSON: GYM },
    stdio: "inherit",
  });

  // Serve dist on a random port
  server = createServer((req, res) => {
    const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
    const filePath = join(DIST, url);
    const resolved = existsSync(filePath) ? filePath : join(DIST, "index.html");
    const ext = extname(resolved);
    const content = readFileSync(resolved);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(content);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}, 120_000);

afterAll(async () => {
  await chrome?.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("Lighthouse gate: perf ≥ 90, LCP < 2500ms, SEO ≥ 90, TBT < 200ms", async () => {
  chrome = await launch({ chromeFlags: ["--headless", "--no-sandbox", "--disable-gpu"] });
  const result = await lighthouse(`http://127.0.0.1:${port}/`, {
    port: chrome.port,
    output: "json",
    logLevel: "error",
    onlyCategories: ["performance", "seo"],
  });

  const cats = result!.lhr.categories;
  const audits = result!.lhr.audits;

  const perf = Math.round(cats.performance.score! * 100);
  const seo = Math.round(cats.seo.score! * 100);
  const lcp = audits["largest-contentful-paint"].numericValue ?? Infinity;
  const tbt = audits["total-blocking-time"].numericValue ?? Infinity;

  console.log(
    `Lighthouse: perf=${perf} seo=${seo} LCP=${Math.round(lcp)}ms TBT=${Math.round(tbt)}ms`,
  );

  expect(perf, `Performance score ${perf} < 90`).toBeGreaterThanOrEqual(90);
  expect(seo, `SEO score ${seo} < 90`).toBeGreaterThanOrEqual(90);
  expect(lcp, `LCP ${Math.round(lcp)}ms >= 2500ms`).toBeLessThan(2500);
  expect(tbt, `TBT ${Math.round(tbt)}ms >= 200ms`).toBeLessThan(200);
}, 60_000);
