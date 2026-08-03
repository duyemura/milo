import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { llmJson } from "@milo/llm";
import type { ChatFn, ChatMessage } from "@milo/llm";
import {
  ingestAsset as baseIngest, loadLibrary, saveLibrary, getAsset, updateAssetTags,
} from "@milo/storage";
import type { Asset, AssetTags, AssetLibrary, IngestOpts as BaseIngestOpts, IngestResult as BaseIngestResult } from "@milo/storage";

export type { Asset, AssetTags, AssetLibrary };

export interface IngestOpts extends BaseIngestOpts {
  chat?: ChatFn;
  model?: string;
  brief?: string;
}

export interface IngestResult extends BaseIngestResult {
  tagging: Promise<void>;
}

/** Ingest a local file and optionally trigger async LLM tagging. */
export async function ingestAsset(businessDir: string, opts: IngestOpts): Promise<IngestResult> {
  const base = await baseIngest(businessDir, opts);
  const tagging = opts.chat && opts.model && !base.cached
    ? tagAsset(businessDir, base.assetId, { chat: opts.chat, model: opts.model, brief: opts.brief })
    : Promise.resolve();
  return { ...base, tagging };
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
  const hasPeople = asset.source === "generated" ? false : raw.hasPeople;
  const tags: AssetTags = {
    pending: false, hasPeople, subjects: raw.subjects,
    ...(raw.activity !== undefined ? { activity: raw.activity } : {}),
    mood: raw.mood, setting: raw.setting, description: raw.description, quality: raw.quality,
    ...(raw.qualityNotes !== undefined ? { qualityNotes: raw.qualityNotes } : {}),
  };
  const fresh = loadLibrary(businessDir, lib0.businessId);
  saveLibrary(businessDir, updateAssetTags(fresh, assetId, tags));
}
