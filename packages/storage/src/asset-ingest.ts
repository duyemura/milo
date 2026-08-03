import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  loadLibrary, saveLibrary, addAsset, findByHash, findBySourceRef,
  type Asset, type AssetLibrary, type AssetTags,
} from "./asset-library.ts";

export interface IngestOpts {
  file: string;
  source: "upload" | "generated";
  businessId?: string;
  altText?: string;
  attribution?: string;
  /** Pre-computed SHA-256 hex — skips re-hashing. */
  contentHash?: string;
  sourceRef?: string;
  siteOrigin?: string;
  now?: () => Date;
}

export interface IngestResult {
  assetId: string;
  asset: Asset;
  library: AssetLibrary;
  /** True when an identical asset was already present (dedup hit). */
  cached: boolean;
}

export interface IngestFromUrlOpts extends Omit<IngestOpts, "file" | "contentHash"> {
  /** Inject an alternative fetch for testing. Defaults to global fetch. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface Sniffed { mime: string; w: number; h: number; ext: string; }

export function sniffImage(buf: Buffer): Sniffed {
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") {
    return { mime: "image/png", ext: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF") {
    return { mime: "image/gif", ext: "gif", w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp", ...webpDimensions(buf) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { mime: "image/jpeg", ext: "jpg", ...jpegDimensions(buf) };
  }
  throw new Error("sniffImage: unsupported image format (supports PNG, JPEG, WebP, GIF)");
}

function webpDimensions(buf: Buffer): { w: number; h: number } {
  const fourcc = buf.toString("latin1", 12, 16);
  if (fourcc === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (fourcc === "VP8L") { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
  if (fourcc === "VP8X") { const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)); const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)); return { w, h }; }
  throw new Error("sniffImage: unrecognized WebP chunk");
}

function jpegDimensions(buf: Buffer): { w: number; h: number } {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  throw new Error("sniffImage: could not read JPEG dimensions");
}

function aspectRatioOf(w: number, h: number): Asset["aspectRatio"] {
  if (h === 0) return "other";
  const r = w / h;
  const near = (t: number) => Math.abs(r - t) < 0.02;
  if (near(16 / 9)) return "16:9";
  if (near(1)) return "1:1";
  if (near(4 / 3)) return "4:3";
  if (near(3 / 2)) return "3:2";
  return "other";
}

function pendingTags(): AssetTags {
  return { pending: true, hasPeople: false, subjects: [], mood: [], setting: "product", description: "", quality: "medium" };
}

function ingestBuffer(businessDir: string, buf: Buffer, opts: Omit<IngestOpts, "file">): IngestResult {
  const sniffed = sniffImage(buf);
  const id = `ast_${crypto.randomUUID()}`;
  const rel = `library/${id}.${sniffed.ext}`;
  const dest = path.join(businessDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  const hash = opts.contentHash ?? crypto.createHash("sha256").update(buf).digest("hex");
  const now = (opts.now ?? (() => new Date()))();
  const asset: Asset = {
    id,
    source: opts.source,
    file: rel,
    mime: sniffed.mime,
    dimensions: { w: sniffed.w, h: sniffed.h },
    aspectRatio: aspectRatioOf(sniffed.w, sniffed.h),
    bytes: buf.length,
    tags: pendingTags(),
    contentHash: hash,
    ...(opts.sourceRef !== undefined ? { sourceRef: opts.sourceRef } : {}),
    ...(opts.altText !== undefined ? { altText: opts.altText } : {}),
    ...(opts.attribution !== undefined ? { attribution: opts.attribution } : {}),
    ...(opts.siteOrigin !== undefined ? { siteOrigin: opts.siteOrigin } : {}),
    usages: [],
    status: "active",
    createdAt: now.toISOString(),
  };
  const library = addAsset(loadLibrary(businessDir, opts.businessId ?? "biz_unknown"), asset);
  saveLibrary(businessDir, library);
  return { assetId: id, asset, library, cached: false };
}

/** Ingest a local file into the library. No dedup check — caller is responsible. */
export async function ingestAsset(businessDir: string, opts: IngestOpts): Promise<IngestResult> {
  const buf = fs.readFileSync(opts.file);
  return ingestBuffer(businessDir, buf, opts);
}

/**
 * Download a URL and ingest into the library. Two-level dedup:
 *  1. sourceRef match (pre-download, skips both API call and fetch)
 *  2. SHA-256 content hash (post-download, catches identical bytes from different URLs)
 */
export async function ingestFromUrl(businessDir: string, url: string, opts: IngestFromUrlOpts): Promise<IngestResult> {
  const lib0 = loadLibrary(businessDir, opts.businessId ?? "biz_unknown");

  if (opts.sourceRef) {
    const existing = findBySourceRef(lib0, opts.sourceRef);
    if (existing) return { assetId: existing.id, asset: existing, library: lib0, cached: true };
  }

  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0" } } as RequestInit);
  if (!res.ok) throw new Error(`ingestFromUrl: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash("sha256").update(buf).digest("hex");

  const dup = findByHash(lib0, hash);
  if (dup) return { assetId: dup.id, asset: dup, library: lib0, cached: true };

  const { fetchFn: _drop, ...rest } = opts;
  return ingestBuffer(businessDir, buf, { ...rest, contentHash: hash });
}
