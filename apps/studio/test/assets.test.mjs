import { test, expect } from "vitest";
import { collectAssetUrls, rewriteRefs } from "../src/assets.mjs";

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
