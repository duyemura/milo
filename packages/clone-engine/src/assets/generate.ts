import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { SiteRef } from "../edit/types.ts";
import { swapAsset } from "../edit/ops.ts";
import { buildPrompt, classifyBrief, UnsafeBriefError, type SafeImageCategory } from "./safety.ts";

const FAL_ENDPOINT = "https://fal.run/fal-ai/flux/dev";

export interface GenerateAssetArgs {
  alias: string;
  brief: string;
  category?: SafeImageCategory;
  aspectRatio?: "16:9" | "1:1" | "4:3";
  /** Threaded to ingestAsset for async CV tagging (optional; tests omit it). */
  chat?: import("@milo/llm").ChatFn;
  model?: string;
}

export interface GenerateAssetResult {
  ok: boolean;
  assetAlias: string;
  failures: string[];
}

function imageSizeFor(aspectRatio: GenerateAssetArgs["aspectRatio"]): string {
  switch (aspectRatio) {
    case "1:1": return "square_hd";
    case "4:3": return "landscape_4_3";
    case "16:9":
    default: return "landscape_16_9";
  }
}

export async function generateAsset(site: SiteRef, args: GenerateAssetArgs): Promise<GenerateAssetResult> {
  const { alias, brief } = args;

  // Always run the UNSAFE_PATTERNS refusal check, even when a category is explicitly supplied.
  // An explicit category only skips the classification step — not the safety check.
  let category: SafeImageCategory;
  try {
    if (args.category) {
      // Explicit category: still run safety check but don't override the caller's category.
      classifyBrief(brief); // throws UnsafeBriefError if brief is unsafe
      category = args.category;
    } else {
      category = classifyBrief(brief); // classify + safety check in one call
    }
  } catch (err) {
    if (err instanceof UnsafeBriefError) {
      return { ok: false, assetAlias: alias, failures: [`${err.message} Suggestion: ${err.suggestion}`] };
    }
    return { ok: false, assetAlias: alias, failures: [`generateAsset: classify failed: ${(err as Error).message}`] };
  }

  const prompt = buildPrompt(category, brief);
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) return { ok: false, assetAlias: alias, failures: ["generateAsset: FAL_API_KEY is not set"] };

  let imageUrl: string;
  try {
    const res = await fetch(FAL_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Key ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt, image_size: imageSizeFor(args.aspectRatio), num_inference_steps: 28, num_images: 1 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { ok: false, assetAlias: alias, failures: [`generateAsset: Flux (fal.ai) returned ${res.status}`] };
    const json = (await res.json()) as { images?: Array<{ url?: string }> };
    const url = json.images?.[0]?.url;
    if (!url) return { ok: false, assetAlias: alias, failures: ["generateAsset: Flux response had no image URL"] };
    imageUrl = url;
  } catch (err) {
    return { ok: false, assetAlias: alias, failures: [`generateAsset: Flux request failed: ${(err as Error).message}`] };
  }

  const tmpFile = path.join(os.tmpdir(), `gen-asset-img-${crypto.randomUUID()}`);
  try {
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    if (!imgRes.ok) return { ok: false, assetAlias: alias, failures: [`generateAsset: image download returned ${imgRes.status}`] };
    fs.writeFileSync(tmpFile, Buffer.from(await imgRes.arrayBuffer()));
    await swapAsset(site, alias, tmpFile);
  } catch (err) {
    return { ok: false, assetAlias: alias, failures: [`generateAsset: swap failed: ${(err as Error).message}`] };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  return { ok: true, assetAlias: alias, failures: [] };
}
