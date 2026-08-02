import fs from "node:fs";
import path from "node:path";
import type { SiteRef, OpResult } from "./types.ts";
import type { SiteManifest } from "../types.ts";
import type { ChatFn } from "@milo/llm";
import { swapAsset } from "./ops.ts";
import { TargetError } from "./target.ts";
import { loadLibrary, saveLibrary, getAsset, recordUsage } from "../assets/library.ts";
import { ingestAsset } from "../assets/ingest.ts";

/** Place a catalogued library asset into a site slot (by alias). */
export async function placeAsset(site: SiteRef, alias: string, assetId: string): Promise<OpResult> {
  const library = loadLibrary(site.dir, "biz_unknown");
  const asset = getAsset(library, assetId);
  if (!asset) throw new TargetError(`placeAsset: asset id not in library: ${assetId}`);
  if (asset.status === "archived") throw new TargetError(`placeAsset: asset is archived: ${assetId}`);

  const absFile = path.join(site.dir, asset.file);
  const result = await swapAsset(site, alias, absFile);

  // Stamp assetId onto the matching site.json asset entry.
  const manifestPath = path.join(site.dir, "site.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SiteManifest & {
    pages: Array<{ route: string; assets: Array<{ alias: string; file: string; assetId?: string }> }>;
  };
  const routes: string[] = [];
  for (const page of manifest.pages) {
    for (const a of page.assets) {
      if (a.alias === alias) { a.assetId = assetId; routes.push(page.route); }
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // Record usage in the library for each placed section.
  let updated = loadLibrary(site.dir, library.businessId);
  const route = routes[0] ?? "/";
  for (const section of result.targetSections) {
    updated = recordUsage(updated, assetId, { alias, route, section });
  }
  if (result.targetSections.length === 0) {
    updated = recordUsage(updated, assetId, { alias, route, section: "" });
  }
  saveLibrary(site.dir, updated);

  return { op: { op: "placeAsset", alias, assetId }, changedFiles: result.changedFiles, targetSections: result.targetSections };
}

export interface UploadOpts { altText?: string; chat?: ChatFn; model?: string; }

/** Owner-facing: ingest a provided photo into the library (as an upload), then place it. */
export async function uploadAsset(site: SiteRef, file: string, alias: string, opts: UploadOpts = {}): Promise<OpResult> {
  const { assetId, tagging } = await ingestAsset(site.dir, { file, source: "upload", altText: opts.altText, chat: opts.chat, model: opts.model });
  // Owner-facing op: block on tagging so the caller sees a fully-classified asset.
  await tagging;
  const result = await placeAsset(site, alias, assetId);
  return { op: { op: "uploadAsset", file, alias, ...(opts.altText !== undefined ? { altText: opts.altText } : {}) }, changedFiles: result.changedFiles, targetSections: result.targetSections };
}
