/**
 * generate.ts — subsystem E: BOUNDED on-brand section generation.
 *
 * The doctrine-sensitive "generation" piece, kept safe by being TEMPLATE-BOUNDED:
 *   - A small library of hand-authored section templates (templates.ts) guarantees
 *     on-brand (var(--color-*)/var(--font-*)/...) + on-contract (data-section/
 *     data-component/data-role/data-copy) BY CONSTRUCTION.
 *   - The LLM fills ONLY the structured copy slots (a Zod schema per template). It never
 *     writes HTML or CSS, so it cannot introduce an off-brand literal or drop a contract
 *     attribute.
 *   - The section is inserted via the SAME machinery addSection uses (index.astro
 *     import/include + site.json sections[]/copy[]/elements[]), then ORACLE-VERIFIED:
 *     every pre-existing section must stay 0-px, astro build must succeed, and the new
 *     section must be present structurally.
 *
 * This EXTENDS the established system; it never redraws the site. Free-form / LLM-drawn
 * HTML is deliberately NOT attempted (see the subsystem-E spec).
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import type { SiteRef, VerifierReport } from "./types.ts";
import type { ManifestSection, ManifestCopyEntry, ManifestElement, SiteManifest, PageGoal } from "../types.ts";
import { loadSite } from "./target.ts";
import { snapshot, restore } from "./history.ts";
import { verify, renderSnapshot, type EditIntent, type RenderSnapshot } from "./verify.ts";
import {
  TEMPLATE_LIBRARY,
  isGenerateRole,
  renderAstroComponent,
  type GenerateRole,
  type RenderedTemplate,
} from "./templates.ts";
import { llmJson } from "@milo/llm";
import type { ChatFn, ChatMessage } from "@milo/llm";

// ---------------------------------------------------------------------------
// insertGeneratedSection — the shared insertion path (mirrors addSection's file surgery,
// but for a FRESH template-rendered section rather than a clone of an existing one).
// ---------------------------------------------------------------------------

/** Generate a unique PascalCase component name for a generated section (Generated<Role><N>). */
function uniqueGeneratedName(role: GenerateRole, site: SiteRef): string {
  const roleCamel = role
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  const base = `Generated${roleCamel}`;
  const componentsDir = path.join(site.dir, "astro", "src", "components");
  const manifest = loadSite(site);
  const existing = new Set<string>();
  if (fs.existsSync(componentsDir)) {
    for (const f of fs.readdirSync(componentsDir)) {
      if (f.endsWith(".astro")) existing.add(f.slice(0, -".astro".length));
    }
  }
  for (const page of manifest.pages) for (const s of page.sections) existing.add(s.name);

  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

/**
 * Insert a rendered template as a new section at the END of the page. Writes the component
 * .astro, appends the template's CSS to global.css, inserts the import + include in
 * index.astro, and adds sections[]/copy[]/elements[] to site.json — the same shape
 * addSection establishes so the section is addressable by the identical C edit ops.
 *
 * Returns the new component name + the pre-insert section order (for the verifier's
 * expectedSectionOrder).
 */
function insertGeneratedSection(
  site: SiteRef,
  componentName: string,
  rt: RenderedTemplate,
): { changedFiles: string[]; beforeOrder: string[] } {
  const componentsDir = path.join(site.dir, "astro", "src", "components");
  fs.mkdirSync(componentsDir, { recursive: true });
  const newFileName = `${componentName}.astro`;
  const newFile = path.join(componentsDir, newFileName);
  const changedFiles: string[] = [];

  // 1. Component .astro (projector shape).
  fs.writeFileSync(newFile, renderAstroComponent(rt));
  changedFiles.push(newFile);

  // 2. Append the template's brand-token CSS to global.css (if any).
  if (rt.css) {
    const cssPath = path.join(site.dir, "astro", "src", "styles", "global.css");
    const css = fs.readFileSync(cssPath, "utf8");
    fs.writeFileSync(cssPath, css + "\n" + rt.css);
    changedFiles.push(cssPath);
  }

  // 3. index.astro: import + include, appended at the end of the body (same as addSection
  //    with no afterSection). Record the pre-insert order from the manifest for the verifier.
  const manifest = loadSite(site);
  const beforeOrder = manifest.pages[0].sections.map((s) => s.name);

  const idxPath = path.join(site.dir, "astro", "src", "pages", "index.astro");
  let idx = fs.readFileSync(idxPath, "utf8");
  const importLine = `import ${componentName} from "../components/${newFileName}";`;
  const lastImport = [...idx.matchAll(/^import\s+\S+\s+from\s+"[^"]+";/gm)];
  if (lastImport.length > 0) {
    const last = lastImport[lastImport.length - 1];
    const at = last.index! + last[0].length;
    idx = idx.slice(0, at) + "\n" + importLine + idx.slice(at);
  } else {
    const fmClose = idx.indexOf("\n---\n");
    if (fmClose !== -1) idx = idx.slice(0, fmClose) + "\n" + importLine + idx.slice(fmClose);
  }
  // Append the include after the last existing PascalCase include, else before </body>.
  const includeTag = `<${componentName} />`;
  const includes = [...idx.matchAll(/<([A-Z][A-Za-z0-9]*)\s*\/>/g)];
  if (includes.length > 0) {
    const last = includes[includes.length - 1];
    const at = last.index! + last[0].length;
    idx = idx.slice(0, at) + " " + includeTag + idx.slice(at);
  } else {
    idx = idx.replace("</body>", ` ${includeTag} </body>`);
  }
  fs.writeFileSync(idxPath, idx);
  changedFiles.push(idxPath);

  // 4. site.json: sections[] + copy[] + elements[] entries for the new section.
  const newSection: ManifestSection = {
    name: componentName,
    role: rt.sectionRole,
    file: `astro/src/components/${newFileName}`,
    copyKeys: rt.copyKeys,
    elementRoles: rt.elementRoles.map((er) => ({ role: er.role, id: er.id })),
  };
  // Templates author content[] and elementRoles[] in the SAME order (index i's copy sits inside
  // element i), so the owning role for copy slot i is elementRoles[i].role.
  const newCopy: ManifestCopyEntry[] = rt.copyKeys.map((key, index) => {
    const preview = String(rt.content[index] ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    const owner = rt.elementRoles[index];
    return {
      key,
      component: componentName,
      index,
      text: preview,
      ...(owner ? { role: owner.role } : {}),
    };
  });
  const newElements: ManifestElement[] = rt.elementRoles.map((er) => ({
    role: er.role,
    id: er.id,
    component: componentName,
    selector: `[data-component="${componentName}"] [data-role="${er.role}"]`,
  }));

  const page = manifest.pages[0];
  page.sections.push(newSection);
  page.copy.push(...newCopy);
  page.elements.push(...newElements);
  const manifestPath = path.join(site.dir, "site.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  changedFiles.push(manifestPath);

  return { changedFiles, beforeOrder };
}

// ---------------------------------------------------------------------------
// generateSection — the public entry point.
// ---------------------------------------------------------------------------

export interface GenerateSectionArgs {
  /** The section role to generate — MUST be in the template library (bounded vocabulary). */
  role: string;
  /** Optional page goal (advisory — future template picking). */
  goal?: PageGoal;
  /** A short natural-language brief for the copy the LLM should write. */
  brief: string;
}

export interface GenerateSectionResult {
  ok: boolean;
  sectionName: string;
  verifierReport: VerifierReport;
}

const SYSTEM_PROMPT = `You are filling the copy for ONE section of a gym website.
You are given a section template's copy fields and a brief. Fill ONLY the requested fields
with on-brand, concise, benefit-led marketing copy in the gym's voice.
Do NOT add HTML, markdown, styles, or any fields not in the schema — return ONLY the copy strings.
Output valid JSON matching the schema.`;

/**
 * Generate a new section from the bounded template library, fill its copy with the LLM,
 * insert it into the site, and oracle-verify that generation didn't disturb the rest.
 *
 * @param site    the projected OUT dir (must have site.json + brand.json + astro/).
 * @param args    { role (bounded), goal?, brief }.
 * @param chat    injectable ChatFn (real or fakeChat).
 * @param model   model string.
 * @param browser a launched Playwright browser (shared; verifier never launches its own).
 * @param opts    { width?, assetsFallback? } passed through to the verifier.
 *
 * Throws if `role` is not in the library (bounded vocabulary — NO free-draw path).
 */
export async function generateSection(
  site: SiteRef,
  args: GenerateSectionArgs,
  chat: ChatFn,
  model: string,
  browser: Browser,
  opts: { width?: number; assetsFallback?: string | null } = {},
): Promise<GenerateSectionResult> {
  // BOUNDED VOCABULARY: reject any role the library can't generate. This is the guardrail that
  // makes "generation within the system" true — there is no path to a free-drawn section.
  if (!isGenerateRole(args.role)) {
    throw new Error(
      `generateSection: role "${args.role}" is not in the template library. ` +
        `Bounded vocabulary: ${Object.keys(TEMPLATE_LIBRARY).join(", ")}.`,
    );
  }
  const template = TEMPLATE_LIBRARY[args.role];

  // Snapshot BEFORE — the oracle baseline every pre-existing section is diffed against.
  const width = opts.width ?? 1440;
  const before: RenderSnapshot = await renderSnapshot(browser, site, {
    width,
    assetsFallback: opts.assetsFallback,
  });

  // LLM fills ONLY the copy slots (schema-constrained). It never writes HTML/CSS.
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Section template: ${template.description}\n` +
        `Brief: ${args.brief}\n\n` +
        `Fill ONLY the copy fields defined by the schema.`,
    },
  ];
  const filled = await llmJson(template.slotSchema, { chat, model, messages, temperature: 0.4 });

  // Render the template with the filled copy + a unique component name → on-brand, on-contract.
  // `template` is a union of the library's templates; its slotSchema + render are correlated
  // internally (llmJson validated `filled` against THIS template's schema), but the union widens
  // render's param to the intersection. Bridge with a single localized cast — safe because
  // `filled` was just produced from `template.slotSchema`.
  const componentName = uniqueGeneratedName(args.role, site);
  const render = template.render as (f: unknown, comp: string) => RenderedTemplate;
  const rt = render(filled, componentName);

  // Pre-insert rollback point. insertGeneratedSection mutates 4 files (new .astro, APPENDS to the
  // shared global.css, edits index.astro, rewrites site.json). If verification fails we must NOT
  // leave the half-inserted section + global.css cruft on disk — same "never ships broken"
  // invariant apply() upholds. Snapshot the editable subtree, restore it on any non-pass.
  const token = snapshot(site);

  // Insert via the shared insertion path (mirrors addSection).
  const { beforeOrder } = insertGeneratedSection(site, componentName, rt);

  // Oracle-verify: addSection-style intent. The new section is proven present structurally +
  // render-sanity (it has no "before" crop to pixel-diff); every PRE-EXISTING section must stay
  // 0-px. On-brand + on-contract are proven by construction + asserted by the caller/tests.
  const intent: EditIntent = {
    editedSections: [componentName],
    op: { op: "addSection", cloneOf: componentName },
    expectedSectionOrder: [...beforeOrder, componentName],
  };
  const verifierReport = await verify(browser, before, site, intent, {
    width,
    assetsFallback: opts.assetsFallback,
  });

  // On failure, roll back to the pre-insert state so a broken/off-scope generation never ships.
  if (!verifierReport.pass) {
    restore(site, token);
    return { ok: false, sectionName: componentName, verifierReport };
  }

  return { ok: true, sectionName: componentName, verifierReport };
}

/** Re-export the library + role guard so callers can enumerate the bounded vocabulary. */
export { TEMPLATE_LIBRARY, isGenerateRole } from "./templates.ts";
export type { GenerateRole } from "./templates.ts";
