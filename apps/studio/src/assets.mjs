import fs from "node:fs";
import path from "node:path";

/** All unique remote asset URLs referenced by a capture bundle. */
export function collectAssetUrls(bundle) {
  const urls = new Set();
  for (const img of bundle.images ?? []) if (img.src?.startsWith("http")) urls.add(img.src);
  for (const u of bundle.fontUrls ?? []) if (u?.startsWith("http")) urls.add(u);
  return [...urls];
}

/** Return a deep-ish copy of the bundle with remote urls replaced by local paths. */
export function rewriteRefs(bundle, map) {
  const swap = (u) => map[u] ?? u;
  return {
    ...bundle,
    images: (bundle.images ?? []).map((i) => ({ ...i, src: swap(i.src) })),
    fontUrls: (bundle.fontUrls ?? []).map(swap),
  };
}

/** Download each url into `dir`, returning { url -> relativeLocalPath }. Integration-only. */
export async function downloadAssets(urls, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const map = {};
  let i = 0;
  for (const url of urls) {
    const ext = (path.extname(new URL(url).pathname) || ".bin").split("?")[0];
    const name = `asset-${String(i++).padStart(3, "0")}${ext}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(dir, name), buf);
      map[url] = path.join("assets", name);
    } catch { /* skip unreachable asset; eval will flag any missing */ }
  }
  return map;
}
