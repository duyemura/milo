import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PageDocument, IdentityCrawl, BrandCrawl, PagesJson } from "@milo/schema";
import { generateSite } from "@milo/generate";
import type { ChatFn } from "@milo/llm";

export interface RunGenerateOptions {
  docsDir: string;
  outDir: string;
  chat: ChatFn;
  model: string;
}

/**
 * Reproject an intake crawl/doc bundle into a `gym.json` without re-crawling.
 * Reads identity.json, brand.json, pages.json, and pages/<slug>.json from the
 * crawl bundle, plus optional context.json and business.json from the doc root.
 */
export async function runGenerate({ docsDir, outDir, chat, model }: RunGenerateOptions): Promise<void> {
  const [identityRaw, brandRaw, pagesMetaRaw] = await Promise.all([
    readFile(path.join(docsDir, "crawl/identity.json"), "utf8"),
    readFile(path.join(docsDir, "crawl/brand.json"), "utf8"),
    readFile(path.join(docsDir, "crawl/pages.json"), "utf8"),
  ]);
  const identity = IdentityCrawl.parse(JSON.parse(identityRaw));
  const brand = BrandCrawl.parse(JSON.parse(brandRaw));
  const inventory = PagesJson.parse(JSON.parse(pagesMetaRaw));

  const pagesDir = path.join(docsDir, "crawl/pages");
  const pageFiles = await readdir(pagesDir);
  const pageDocs = await Promise.all(
    pageFiles
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        const raw = await readFile(path.join(pagesDir, f), "utf8");
        return PageDocument.parse(JSON.parse(raw));
      }),
  );

  const budgets = new Map(inventory.pages.map((p) => [p.slug, p.llmBudget] as const));
  const slugs = new Set(pageDocs.map((p) => p.slug));
  for (const p of inventory.pages) {
    if (!slugs.has(p.slug)) {
      console.warn(`[generate] missing crawl/pages/${p.slug}.json — skipping ${p.url}`);
    }
  }

  let context: Record<string, unknown> | undefined;
  let business: Record<string, unknown> | undefined;
  try {
    context = JSON.parse(await readFile(path.join(docsDir, "context.json"), "utf8"));
  } catch { /* optional */ }
  try {
    business = JSON.parse(await readFile(path.join(docsDir, "business.json"), "utf8"));
  } catch { /* optional */ }

  const { gym } = await generateSite({
    chat,
    model,
    identity,
    brand,
    pages: pageDocs,
    budgets,
    context,
    business,
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "gym.json"), JSON.stringify(gym, null, 2), "utf8");
  console.log(`[generate] Wrote gym.json to ${outDir}`);
}
