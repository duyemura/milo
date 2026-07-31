import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectAssetUrls, rewriteRefs, downloadAssets } from "../src/assets.mjs";

const bundle = {
  images: [{ src: "https://x.com/a.webp", w: 100, h: 100, alt: "" },
           { src: "https://x.com/a.webp", w: 100, h: 100, alt: "" }],
  fontUrls: ["https://x.com/f.woff2"],
};

test("collectAssetUrls dedupes across images and fonts", () => {
  expect(collectAssetUrls(bundle).sort()).toEqual(
    ["https://x.com/a.webp", "https://x.com/f.woff2"].sort(),
  );
});

test("rewriteRefs swaps remote urls for local paths", () => {
  const map = { "https://x.com/a.webp": "assets/a.webp", "https://x.com/f.woff2": "assets/f.woff2" };
  const out = rewriteRefs(bundle, map);
  expect(out.images[0].src).toBe("assets/a.webp");
  expect(out.fontUrls[0]).toBe("assets/f.woff2");
  // original untouched (pure)
  expect(bundle.images[0].src).toBe("https://x.com/a.webp");
});

test("downloadAssets returns map, failures, and stats even with no urls", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "assets-"));
  try {
    const result = await downloadAssets([], dir);
    expect(result).toHaveProperty("map");
    expect(result).toHaveProperty("failures");
    expect(result).toHaveProperty("stats");
    expect(result.stats).toEqual({ total: 0, ok: 0, failed: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
