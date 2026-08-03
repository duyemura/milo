import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "../../../src/project.ts";
import { renderSnapshot, verify, type EditIntent } from "../../../src/edit/verify.ts";
import { loadSite } from "../../../src/edit/target.ts";
import { renderAstroComponent } from "../../../src/edit/templates.ts";
import { emitTemplate } from "../../../src/harvest/emit.ts";
import { clusterArchetypes } from "../../../src/harvest/library.ts";
import { ctaLeft, ctaRight } from "../fixtures.ts";
import type { SiteRef } from "../../../src/edit/types.ts";
import type { SiteManifest, ManifestSection } from "../../../src/types.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(dir, "../../..");
const REPO = path.resolve(PKG, "../../..");

// snapshot.ts reads process.env.ASTRO_MODULES; set it early so astroBuild finds node_modules.
// REPO = /Users/dan/pushpress; main checkout is at pushpress/milo/page-clone-spike/out-project-page/.
if (!process.env.ASTRO_MODULES) {
  const candidate = path.join(REPO, "milo", "page-clone-spike/out-project-page/astro/node_modules");
  if (fs.existsSync(path.join(candidate, ".bin/astro"))) {
    process.env.ASTRO_MODULES = candidate;
  }
}

function findAstroModules(): string | null {
  const candidates = [
    process.env.ASTRO_MODULES,
    path.join(REPO, "page-clone-spike/out-project-page/astro/node_modules"),
    // worktree: REPO resolves to /Users/dan/pushpress; main checkout is pushpress/milo
    path.join(REPO, "milo", "page-clone-spike/out-project-page/astro/node_modules"),
    path.join(PKG, "node_modules"),
    path.join(REPO, "node_modules"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".bin/astro")) || fs.existsSync(path.join(c, "astro"))) return c;
  }
  return null;
}
const ASTRO_MODULES = findAstroModules();

/** Insert a rendered template the SAME way generate.ts's insertGeneratedSection does. */
function insertHarvested(
  site: SiteRef,
  comp: string,
  rt: ReturnType<ReturnType<typeof emitTemplate>["template"]["render"]>,
): string[] {
  const componentsDir = path.join(site.dir, "astro", "src", "components");
  fs.mkdirSync(componentsDir, { recursive: true });
  const file = path.join(componentsDir, `${comp}.astro`);
  fs.writeFileSync(file, renderAstroComponent(rt));
  if (rt.css) {
    const cssPath = path.join(site.dir, "astro", "src", "styles", "global.css");
    fs.writeFileSync(cssPath, fs.readFileSync(cssPath, "utf8") + "\n" + rt.css);
  }
  const idxPath = path.join(site.dir, "astro", "src", "pages", "index.astro");
  let idx = fs.readFileSync(idxPath, "utf8");
  const importLine = `import ${comp} from "../components/${comp}.astro";`;
  const imports = [...idx.matchAll(/^import\s+\S+\s+from\s+"[^"]+";/gm)];
  const at = imports.length
    ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length
    : idx.indexOf("\n---\n");
  idx = idx.slice(0, at) + "\n" + importLine + idx.slice(at);
  const includes = [...idx.matchAll(/<([A-Z][A-Za-z0-9]*)\s*\/>/g)];
  const iat = includes.length
    ? includes[includes.length - 1].index! + includes[includes.length - 1][0].length
    : idx.indexOf("</body>");
  idx = idx.slice(0, iat) + ` <${comp} />` + idx.slice(iat);
  fs.writeFileSync(idxPath, idx);

  const manifest = loadSite(site);
  const before = manifest.pages[0].sections.map((s) => s.name);
  const newSection: ManifestSection = {
    name: comp,
    role: rt.sectionRole,
    file: `astro/src/components/${comp}.astro`,
    copyKeys: rt.copyKeys,
    elementRoles: rt.elementRoles.map((er) => ({ role: er.role, id: er.id })),
  };
  manifest.pages[0].sections.push(newSection);
  manifest.pages[0].copy.push(
    ...rt.copyKeys.map((key, index) => ({
      key,
      component: comp,
      index,
      text: String(rt.content[index] ?? "").slice(0, 60),
    })),
  );
  manifest.pages[0].elements.push(
    ...rt.elementRoles.map((er) => ({
      role: er.role,
      id: er.id,
      component: comp,
      selector: `[data-component="${comp}"] [data-role="${er.role}"]`,
    })),
  );
  fs.writeFileSync(path.join(site.dir, "site.json"), JSON.stringify(manifest, null, 2) + "\n");
  return before;
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const cleanup = new Set<string>();
afterAll(() => { for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(!ASTRO_MODULES)("emitted harvested template integrates via the generate.ts insertion path", () => {
  it("inserts a harvested cta-band; every pre-existing section stays 0-px (oracle-clean)", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-int-"));
    cleanup.add(outDir);
    await project({ dir: path.join(PKG, "test", "golden", "speakeasy"), out: outDir });
    const site: SiteRef = { dir: outDir };

    const arch = Object.values(clusterArchetypes([ctaLeft, ctaRight]))[0];
    const emitted = emitTemplate(arch);
    const filled: Record<string, string> = {};
    const schema = emitted.template.slotSchema as unknown as { shape: Record<string, unknown> };
    for (const k of Object.keys(schema.shape)) filled[k] = "Join us today";
    const comp = "HarvestedCtaBand";
    const rt = emitted.template.render(filled, comp);

    const before = await renderSnapshot(browser, site, { width: 1440 });
    const beforeOrder = insertHarvested(site, comp, rt);

    const intent: EditIntent = {
      editedSections: [comp],
      op: { op: "addSection", cloneOf: comp },
      expectedSectionOrder: [...beforeOrder, comp],
    };
    const report = await verify(browser, before, site, intent, { width: 1440 });

    expect(report.renderSane).toBe(true);
    for (const s of report.sections) {
      if (s.section !== comp) expect(s.outScopePx).toBe(0);
    }
    expect(report.structural.actual).toContain(comp);
  }, 300_000);
});
