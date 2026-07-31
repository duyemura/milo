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

/** Parse a failed download into a coarse reason bucket. */
function classifyError(err, status) {
  if (status != null) return "http";
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("enetunreach") || msg.includes("econnrefused") || msg.includes("fetch")) return "network";
  if (msg.includes("ENOTFOUND") || msg.includes("not found") || msg.includes("dns")) return "dns";
  return "other";
}

/**
 * Download each url into `dir`, returning { url -> relativeLocalPath } plus a
 * summary of failures. Integration-only.
 */
export async function downloadAssets(urls, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const map = {};
  const failures = [];
  let i = 0;
  for (const url of urls) {
    const ext = (path.extname(new URL(url).pathname) || ".bin").split("?")[0];
    const name = `asset-${String(i++).padStart(3, "0")}${ext}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failures.push({ url, status: res.status, reason: classifyError(null, res.status) });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(dir, name), buf);
      map[url] = path.join("assets", name);
    } catch (err) {
      failures.push({ url, reason: classifyError(err, null), message: err?.message });
    }
  }
  const ok = Object.keys(map).length;
  console.log(`[assets] downloaded ${ok}/${urls.length} (${failures.length} failed)`);
  for (const f of failures) {
    console.log(`[assets] failed ${f.reason}: ${f.url}${f.status ? ` (HTTP ${f.status})` : ""}`);
  }
  return { map, failures, stats: { total: urls.length, ok, failed: failures.length } };
}
