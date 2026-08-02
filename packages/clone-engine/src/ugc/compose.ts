import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Browser } from "playwright";
import { llmJson } from "@milo/llm";
import type { ChatFn } from "@milo/llm";
import type { SiteRef } from "../edit/types.ts";
import type { SiteManifest } from "../types.ts";
import { addPage, addNavLink, removeSection } from "../edit/ops.ts";
import { generateSection } from "../edit/generate.ts";
import { snapshot, restore } from "../edit/history.ts";
import { loadSite } from "../edit/target.ts";
import { BLUEPRINTS, routeOf, slugify, titleFromRoute, type ContentKind } from "./blueprints.ts";

export interface ComposePageArgs {
  route: string;
  kind: ContentKind;
  brief: string;
  addToNav?: boolean;
  navText?: string;
}

export interface ComposePageResult {
  ok: boolean;
  /** The SANITIZED route the page was created at (e.g. "/blog-best-crossfit-brooklyn/"). */
  route: string;
  sections: string[];
  siteReport?: { blockerCount: number };
  failures: string[];
}

const OutlineSchema = z.object({
  sectionBriefs: z.array(z.string().min(1)),
});

const MetaSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

const OUTLINE_SYSTEM =
  "You outline a web page from a brief. For each section role in the blueprint, write a short " +
  "(1-2 sentence) section brief that is coherent with the others — one continuous story, no " +
  "contradictions, no repetition. Return JSON { sectionBriefs: string[] } with EXACTLY one brief " +
  "per role, in the given order.";

const META_SYSTEM =
  "You write SEO metadata for a web page. Return JSON { title, description }. Title <= 60 chars, " +
  "description <= 155 chars, both benefit-led and specific to the brief. No quotes around the values.";

function applyPageMeta(src: string, meta: { title: string; description: string }): string {
  const esc = (s: string) => s.replace(/"/g, "&quot;");
  let out = src.replace(/<title>[^<]*<\/title>/i, `<title>${meta.title}</title>`);
  if (/name="description"/.test(out)) {
    out = out.replace(/(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${esc(meta.description)}$2`);
  } else {
    out = out.replace(/<\/head>/i, `<meta name="description" content="${esc(meta.description)}" />\n</head>`);
  }
  return out;
}

function pageAstroPath(site: SiteRef, slug: string): string {
  const file = slug === "" ? "index.astro" : `${slug}.astro`;
  return path.join(site.dir, "astro", "src", "pages", file);
}

function readSiteName(site: SiteRef): string {
  const labelsPath = path.join(site.dir, "labels.json");
  if (fs.existsSync(labelsPath)) {
    try {
      const labels = JSON.parse(fs.readFileSync(labelsPath, "utf8")) as { site?: { name?: string } };
      if (labels.site?.name) return labels.site.name;
    } catch { /* malformed — fall through */ }
  }
  return "our business";
}

/**
 * Compose a full content page from a brief. Atomic + reversible: on any failure the site is
 * restored byte-identically and { ok:false, failures } is returned.
 */
export async function composePage(
  site: SiteRef,
  args: ComposePageArgs,
  chat: ChatFn,
  model: string,
  browser: Browser,
  opts: { width?: number; assetsFallback?: string | null } = {},
): Promise<ComposePageResult> {
  const failures: string[] = [];
  const blueprint = BLUEPRINTS[args.kind];
  if (!blueprint) {
    return { ok: false, route: args.route, sections: [], failures: [`unknown kind "${args.kind}"`] };
  }

  let slug: string;
  let route: string;
  try {
    slug = slugify(args.route);
    route = routeOf(args.route);
  } catch (err) {
    return { ok: false, route: args.route, sections: [], failures: [(err as Error).message] };
  }

  const token = snapshot(site);
  const sections: string[] = [];

  try {
    // 1. Scaffold the page (clones a template page's sections).
    const added = addPage(site, args.route);

    // 2. Remove cloned sections so the blueprint fills a clean page.
    for (const cloned of added.targetSections) {
      removeSection(site, cloned);
    }

    // 3. ONE planning call: outline coherent briefs per section.
    const outline = await llmJson(OutlineSchema, {
      chat, model,
      messages: [
        { role: "system", content: OUTLINE_SYSTEM },
        { role: "user", content: `Page brief: ${args.brief}\nPage kind: ${args.kind}\nSection roles (in order): ${blueprint.join(", ")}` },
      ],
    });
    const briefFor = (i: number): string => outline.sectionBriefs[i]?.trim() || args.brief;

    // 4. Fill each blueprint role in order on the new page.
    for (let i = 0; i < blueprint.length; i++) {
      const role = blueprint[i];
      const res = await generateSection(site, { role, brief: briefFor(i), targetRoute: route }, chat, model, browser, opts);
      if (!res.ok) {
        failures.push(`section ${i} (${role}) failed: ${res.verifierReport.failures.join(" | ") || "verify failed"}`);
        restore(site, token);
        return { ok: false, route, sections, failures };
      }
      sections.push(res.sectionName);
    }

    // 5. LLM-quality SEO meta → durable page .astro source injection.
    const siteName = readSiteName(site);
    const meta = await llmJson(MetaSchema, {
      chat, model,
      messages: [
        { role: "system", content: META_SYSTEM },
        { role: "user", content: `Page brief: ${args.brief}\nBusiness: ${siteName}\nRoute: ${route}` },
      ],
    });
    const astroPath = pageAstroPath(site, slug);
    if (fs.existsSync(astroPath)) {
      fs.writeFileSync(astroPath, applyPageMeta(fs.readFileSync(astroPath, "utf8"), meta));
    } else {
      failures.push(`page .astro not found for meta injection: ${astroPath}`);
      restore(site, token);
      return { ok: false, route, sections, failures };
    }

    // 6. Optional nav link.
    if (args.addToNav) {
      addNavLink(site, args.navText ?? titleFromRoute(route), route);
    }

    // 7. Lightweight verify.
    const manifest: SiteManifest = loadSite(site);
    const page = manifest.pages.find((p) => p.route === route);
    if (!page) failures.push(`route ${route} not found in site.json after compose`);
    else {
      for (const name of sections) {
        if (!page.sections.some((s) => s.name === name)) failures.push(`${name} missing from site.json for ${route}`);
      }
    }
    if (!fs.existsSync(astroPath)) failures.push(`page .astro missing: ${astroPath}`);

    if (failures.length > 0) {
      restore(site, token);
      return { ok: false, route, sections, failures };
    }

    return { ok: true, route, sections, siteReport: { blockerCount: 0 }, failures };
  } catch (err) {
    restore(site, token);
    return { ok: false, route, sections, failures: [...failures, (err as Error).message] };
  }
}
