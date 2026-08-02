import fs from "node:fs";
import path from "node:path";

export interface Asset {
  id: string;
  source: "upload" | "generated";
  file: string;                       // relative to businessDir: "library/ast_x.webp"
  mime: string;
  dimensions: { w: number; h: number };
  aspectRatio: "16:9" | "1:1" | "4:3" | "3:2" | "other";
  bytes: number;
  tags: AssetTags;
  altText?: string;
  usages: AssetUsage[];
  status: "active" | "archived";
  createdAt: string;
}

export interface AssetTags {
  pending: boolean;
  hasPeople: boolean;
  subjects: string[];
  activity?: string;
  mood: string[];
  setting: "interior" | "exterior" | "studio" | "abstract" | "food" | "product";
  description: string;
  embedding?: number[];
  quality: "low" | "medium" | "high";
  qualityNotes?: string[];
}

export interface AssetUsage { alias: string; route: string; section: string; }

export interface AssetLibrary {
  version: 1;
  businessId: string;
  assets: Record<string, Asset>;
}

const LIBRARY_FILE = "library.json";

export function emptyLibrary(businessId: string): AssetLibrary {
  return { version: 1, businessId, assets: {} };
}

export function loadLibrary(businessDir: string, fallbackBusinessId: string): AssetLibrary {
  const p = path.join(businessDir, LIBRARY_FILE);
  if (!fs.existsSync(p)) return emptyLibrary(fallbackBusinessId);
  return JSON.parse(fs.readFileSync(p, "utf8")) as AssetLibrary;
}

export function saveLibrary(businessDir: string, library: AssetLibrary): void {
  fs.writeFileSync(path.join(businessDir, LIBRARY_FILE), JSON.stringify(library, null, 2) + "\n");
}

export function addAsset(library: AssetLibrary, asset: Asset): AssetLibrary {
  if (library.assets[asset.id]) throw new Error(`addAsset: asset id already exists: ${asset.id}`);
  return { ...library, assets: { ...library.assets, [asset.id]: asset } };
}

export function getAsset(library: AssetLibrary, id: string): Asset | undefined {
  return library.assets[id];
}

export function updateAssetTags(library: AssetLibrary, id: string, tags: AssetTags): AssetLibrary {
  const asset = library.assets[id];
  if (!asset) throw new Error(`updateAssetTags: unknown asset id: ${id}`);
  return { ...library, assets: { ...library.assets, [id]: { ...asset, tags } } };
}

export function archiveAsset(library: AssetLibrary, id: string): AssetLibrary {
  const asset = library.assets[id];
  if (!asset) throw new Error(`archiveAsset: unknown asset id: ${id}`);
  return { ...library, assets: { ...library.assets, [id]: { ...asset, status: "archived" } } };
}

export function recordUsage(library: AssetLibrary, id: string, usage: AssetUsage): AssetLibrary {
  const asset = library.assets[id];
  if (!asset) throw new Error(`recordUsage: unknown asset id: ${id}`);
  const exists = asset.usages.some((u) => u.alias === usage.alias && u.route === usage.route && u.section === usage.section);
  const usages = exists ? asset.usages : [...asset.usages, usage];
  return { ...library, assets: { ...library.assets, [id]: { ...asset, usages } } };
}
