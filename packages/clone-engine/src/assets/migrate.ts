import fs from "node:fs";
import path from "node:path";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../edit/types.ts";
import type { SiteManifest } from "../types.ts";
import { ingestAsset } from "./ingest.ts";
import { loadLibrary, saveLibrary, recordUsage } from "./library.ts";

export interface MigrateOpts { chat?: ChatFn; model?: string; businessId?: string; }
export interface MigrateResult { catalogued: number; skipped: number; assetIds: string[]; }

type PageAsset = { alias: string; file: string; assetId?: string };
type MigratableManifest = SiteManifest & {
  pages: Array<{ route: string; assets: PageAsset[]; sections: Array<{ name: string; file: string }> }>;
};

function sectionsReferencing(businessDir: string, page: MigratableManifest["pages"][number], relFile: string): string[] {
  const slash = `/${relFile}`;
  const names: string[] = [];
  for (const s of page.sections) {
    const p = path.join(businessDir, s.file);
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(slash)) names.push(s.name);
  }
  return names;
}

export async function migrateExistingAssets(businessDir: string, site: SiteRef, opts: MigrateOpts = {}): Promise<MigrateResult> {
  const manifestPath = path.join(businessDir, "site.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as MigratableManifest;
  const businessId = opts.businessId ?? "biz_unknown";
  const byFile = new Map<string, string>();
  const assetIds: string[] = [];
  let catalogued = 0, skipped = 0;

  for (const page of manifest.pages) {
    for (const entry of page.assets) {
      if (entry.assetId) { skipped++; continue; }
      let assetId = byFile.get(entry.file);
      if (!assetId) {
        const abs = path.join(businessDir, entry.file);
        if (!fs.existsSync(abs)) { skipped++; continue; }
        const { assetId: newId, tagging } = await ingestAsset(businessDir, { file: abs, source: "upload", businessId, chat: opts.chat, model: opts.model });
        await tagging;
        assetId = newId;
        byFile.set(entry.file, assetId);
        assetIds.push(assetId);
        catalogued++;
      }
      entry.assetId = assetId;
      let lib = loadLibrary(businessDir, businessId);
      const sections = sectionsReferencing(businessDir, page, entry.file);
      if (sections.length === 0) {
        lib = recordUsage(lib, assetId, { alias: entry.alias, route: page.route, section: "" });
      } else {
        for (const section of sections) lib = recordUsage(lib, assetId, { alias: entry.alias, route: page.route, section });
      }
      saveLibrary(businessDir, lib);
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { catalogued, skipped, assetIds };
}
