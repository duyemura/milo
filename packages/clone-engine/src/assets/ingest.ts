import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { llmJson } from "@milo/llm";
import type { ChatFn, ChatMessage } from "@milo/llm";
import { loadLibrary, saveLibrary, addAsset, updateAssetTags, getAsset, type Asset, type AssetLibrary, type AssetTags } from "./library.ts";

export interface IngestOpts {
  file: string;
  source: "upload" | "generated";
  businessId?: string;
  brief?: string;
  altText?: string;
  chat?: ChatFn;
  model?: string;
  now?: () => Date;
  /** Which site this asset originated from (e.g. "speakeasy-brooklyn"). Omit for generic assets. */
  siteOrigin?: string;
}

export interface IngestResult {
  assetId: string;
  library: AssetLibrary;
  tagging: Promise<void>;
}

interface Sniffed { mime: string; w: number; h: number; ext: string; }

function sniffImage(buf: Buffer): Sniffed {
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
  throw new Error("ingestAsset: could not sniff image header (supported: PNG, JPEG, WebP, GIF)");
}

function webpDimensions(buf: Buffer): { w: number; h: number } {
  const fourcc = buf.toString("latin1", 12, 16);
  if (fourcc === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (fourcc === "VP8L") { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
  if (fourcc === "VP8X") { const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)); const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)); return { w, h }; }
  throw new Error("ingestAsset: unrecognized WebP chunk");
}

function jpegDimensions(buf: Buffer): { w: number; h: number } {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    off += 2 + buf.readUInt16BE(off + 2);
  }
  throw new Error("ingestAsset: could not read JPEG dimensions");
}

function aspectRatioOf(w: number, h: number): Asset["aspectRatio"] {
  if (h === 0) return "other";
  const r = w / h, near = (t: number) => Math.abs(r - t) < 0.02;
  if (near(16 / 9)) return "16:9";
  if (near(1)) return "1:1";
  if (near(4 / 3)) return "4:3";
  if (near(3 / 2)) return "3:2";
  return "other";
}

function pendingTags(): AssetTags {
  return { pending: true, hasPeople: false, subjects: [], mood: [], setting: "product", description: "", quality: "medium" };
}

export async function ingestAsset(businessDir: string, opts: IngestOpts): Promise<IngestResult> {
  const buf = fs.readFileSync(opts.file);
  const sniffed = sniffImage(buf);
  const id = `ast_${crypto.randomUUID()}`;
  const rel = `library/${id}.${sniffed.ext}`;
  const dest = path.join(businessDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  const now = (opts.now ?? (() => new Date()))();
  const asset: Asset = {
    id, source: opts.source, file: rel, mime: sniffed.mime,
    dimensions: { w: sniffed.w, h: sniffed.h }, aspectRatio: aspectRatioOf(sniffed.w, sniffed.h),
    bytes: buf.length, tags: pendingTags(),
    ...(opts.altText !== undefined ? { altText: opts.altText } : {}),
    usages: [], status: "active", createdAt: now.toISOString(),
    ...(opts.siteOrigin !== undefined ? { siteOrigin: opts.siteOrigin } : {}),
  };
  const businessId = opts.businessId ?? loadLibrary(businessDir, "biz_unknown").businessId;
  const library = addAsset(loadLibrary(businessDir, businessId), asset);
  saveLibrary(businessDir, library);
  const tagging = opts.chat && opts.model
    ? tagAsset(businessDir, id, { chat: opts.chat, model: opts.model, brief: opts.brief })
    : Promise.resolve();
  return { assetId: id, library, tagging };
}

const AssetTagsSchema = z.object({
  hasPeople: z.boolean(),
  subjects: z.array(z.string()),
  activity: z.string().optional(),
  mood: z.array(z.string()),
  setting: z.enum(["interior", "exterior", "studio", "abstract", "food", "product"]),
  description: z.string(),
  quality: z.enum(["low", "medium", "high"]),
  qualityNotes: z.array(z.string()).optional(),
});

const TAG_SYSTEM = `You are a computer-vision tagger for a local-business website media library. Look at the image and return STRICT JSON:
- hasPeople: true if any recognizable human (face, body, hands) appears.
- subjects: concrete nouns in frame (e.g. "barbell", "kettlebell", "squat rack", "salad bowl").
- activity: one of "lifting" | "coaching" | "stretching" | "eating" | omit if none.
- mood: evocative adjectives ("energetic", "welcoming", "focused", "calm").
- setting: "interior" | "exterior" | "studio" | "abstract" | "food" | "product".
- description: ONE sentence describing the image (this becomes a search embedding).
- quality: "low" | "medium" | "high" (sharpness, lighting, composition, resolution).
- qualityNotes: optional issues, e.g. ["blurry", "overexposed", "low-resolution"].
Return ONLY the JSON object. No markdown.`;

export interface TagOpts { chat: ChatFn; model: string; brief?: string; }

export async function tagAsset(businessDir: string, assetId: string, opts: TagOpts): Promise<void> {
  const lib0 = loadLibrary(businessDir, "biz_unknown");
  const asset = getAsset(lib0, assetId);
  if (!asset) throw new Error(`tagAsset: unknown asset id: ${assetId}`);
  const buf = fs.readFileSync(path.join(businessDir, asset.file));
  const dataUri = `data:${asset.mime};base64,${buf.toString("base64")}`;
  const messages: ChatMessage[] = [
    { role: "system", content: TAG_SYSTEM },
    { role: "user", content: [
      { type: "text", text: opts.brief ? `Context (generation brief): ${opts.brief}` : "Tag this image." },
      { type: "image_url", image_url: { url: dataUri } },
    ] as unknown as string },
  ];
  const raw = await llmJson(AssetTagsSchema, { chat: opts.chat, model: opts.model, messages, temperature: 0 });
  // Safety: a generated asset can never contain real people — the engine refuses to generate them.
  // Force hasPeople:false so a mis-tag can't route a generated image into people-requiring slots.
  const hasPeople = asset.source === "generated" ? false : raw.hasPeople;
  const tags: AssetTags = {
    pending: false, hasPeople, subjects: raw.subjects,
    ...(raw.activity !== undefined ? { activity: raw.activity } : {}),
    mood: raw.mood, setting: raw.setting, description: raw.description, quality: raw.quality,
    ...(raw.qualityNotes !== undefined ? { qualityNotes: raw.qualityNotes } : {}),
    // embedding: v1 stub — findAsset falls back to recency
  };
  const fresh = loadLibrary(businessDir, lib0.businessId);
  saveLibrary(businessDir, updateAssetTags(fresh, assetId, tags));
}
