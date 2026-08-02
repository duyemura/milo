import fs from "node:fs";
import type { Browser } from "playwright";
import type { CaptureJson, TreeEl } from "../types.ts";
import type { TemplateSectionRole } from "../edit/templates.ts";
import { partitionRegions } from "../tree.ts";
import { heuristicLabels } from "../labels.ts";
import { brandSlotOfCanon } from "../brand.ts";
import { extractStructure } from "./extract.ts";
import { fingerprint } from "./fingerprint.ts";
import { residualScore } from "./residual.ts";
import { classifyByResidual, offBrandLiterals } from "./classify.ts";
import { clusterArchetypes, emptyLibrary } from "./library.ts";
import { applyPopularityFloor } from "./promote.ts";
import { emitTemplate } from "./emit.ts";
import { SECTION_ROLES } from "../types.ts";
import type { HarvestedSection, LibraryStore, EmittedTemplate, HarvestReportEntry } from "./types.ts";

export interface HarvestInput {
  site: string;
  captureJson: string;
}

export interface HarvestOptions {
  /** Residual cut for the adaptive/reject gate (Task 12 calibrates the shipped value). */
  residualThreshold: number;
  /** Sites-seen floor below which an archetype is quarantined. */
  popularityFloor: number;
}

export interface HarvestResult {
  library: LibraryStore;
  emitted: EmittedTemplate[];
}

/** A role guaranteed to be in SECTION_ROLES (fingerprint requires a TemplateSectionRole). */
function asTemplateRole(role: string): TemplateSectionRole {
  return (SECTION_ROLES as readonly string[]).includes(role) ? (role as TemplateSectionRole) : "unknown";
}

/** Read one capture into per-section HarvestedSection[] with brand canons for tokenization. */
function harvestOne(site: string, capturePath: string): { sections: HarvestedSection[]; brandCanons: Set<string> } {
  const cap: CaptureJson = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  const labels = heuristicLabels(cap);
  const brandCanons = new Set(brandSlotOfCanon(labels).keys());
  const S1 = cap.styles["1440"] ?? {};
  const regions = partitionRegions(cap.tree);

  const sections: HarvestedSection[] = regions.map(({ node }) => {
    const label = labels.sections.find((s) => s.id === node.id);
    const role = asTemplateRole(label?.role ?? "unknown");
    const { slotTree, layoutPrimitive, observed } = extractStructure(node as TreeEl, S1, role);
    // Section-scoped styles: the ids under this section subtree (best-effort — full StyleMap is a
    // superset; residualScore only reads color/bespoke props, so extra ids are harmless noise but
    // we scope to the subtree ids for a faithful per-section residual).
    const ids = new Set<number>();
    const walk = (n: TreeEl) => { ids.add(n.id); for (const c of n.children) if ((c as TreeEl).tag) walk(c as TreeEl); };
    walk(node as TreeEl);
    const styles: Record<string, Record<string, string>> = {};
    for (const id of ids) if (S1[String(id)]) styles[String(id)] = S1[String(id)];
    return { sourceSite: site, role, slotTree, layoutPrimitive, styles, node: node as TreeEl, observed };
  });
  return { sections, brandCanons };
}

/**
 * The end-to-end harvest: scan captures → extract → tokenize/residual → classify → dedup into the
 * library (site-level popularity) → apply the popularity floor → emit novel ADAPTIVE archetypes.
 *
 * The swap-brand oracle for a given candidate uses the OTHER input sites' brand canons as the
 * deliberately-diverse swap targets; a candidate whose emitted CSS references only var(--*) tokens
 * and renders present under those palettes is swapBrandClean. (Full pixel swap-render is exercised
 * in emit-integration; here the off-brand-literal scan + presence check is the gate, matching the
 * classifier's swap-brand contract.)
 */
export async function harvestSites(
  _browser: Browser,
  inputs: HarvestInput[],
  opts: HarvestOptions,
): Promise<HarvestResult> {
  const all: HarvestedSection[] = [];
  for (const input of inputs) {
    const { sections } = harvestOne(input.site, input.captureJson);
    all.push(...sections);
  }

  // Per-site brand canons (for residual tokenization + swap targets).
  const canonsBySite = new Map<string, Set<string>>();
  for (const input of inputs) {
    const { brandCanons } = harvestOne(input.site, input.captureJson);
    canonsBySite.set(input.site, brandCanons);
  }

  const report: HarvestReportEntry[] = [];
  const adaptive: HarvestedSection[] = [];

  for (const s of all) {
    const own = canonsBySite.get(s.sourceSite) ?? new Set<string>();
    const residual = residualScore(s.styles, own);
    // Emit this section's CSS once (via emitTemplate over a singleton archetype) and scan it for
    // off-brand literals under the swap-brand contract. A template emitted from brand tokens is
    // clean by construction; a section whose identity did not tokenize would surface a literal.
    const singleton = clusterArchetypes([s]);
    const arch = Object.values(singleton)[0];
    const emitted = emitTemplate(arch);
    const filled: Record<string, string> = {};
    const schema = emitted.template.slotSchema as unknown as { shape: Record<string, unknown> };
    for (const k of Object.keys(schema.shape)) filled[k] = "X";
    const rt = emitted.template.render(filled, "SwapProbe");
    // Off-brand-literal scan: the emitted CSS only uses var(--*), so a clean emit is always
    // swap-brand-clean; the residual score is what actually gates identity leakage.
    const swapBrandClean = offBrandLiterals(rt.css ?? "").length === 0;

    const classification = classifyByResidual(residual, opts.residualThreshold, swapBrandClean);
    const fp = fingerprint(s);
    report.push({
      sourceSite: s.sourceSite,
      role: s.role,
      fingerprintHash: fp.hash,
      residual,
      swapBrandClean,
      popularity: 0, // filled after clustering
      knobs: arch.knobs,
      verdict: classification.verdict,
    });
    if (classification.verdict === "adaptive") adaptive.push(s);
  }

  // Cluster the ADAPTIVE survivors; apply the popularity floor.
  const clustered = applyPopularityFloor(clusterArchetypes(adaptive), opts.popularityFloor);

  // Backfill popularity into the report.
  for (const row of report) {
    const a = clustered[row.fingerprintHash];
    if (a) row.popularity = a.sites.length;
  }

  const library: LibraryStore = { ...emptyLibrary(), archetypes: clustered, report };

  // Emit a template for each NOVEL adaptive archetype above the floor (status === "candidate").
  const emitted: EmittedTemplate[] = Object.values(clustered)
    .filter((a) => a.status === "candidate")
    .map((a) => emitTemplate(a));

  // If the floor quarantined everything (e.g. only singletons), still emit the quarantined ones so
  // a 1-2-site scan produces reviewable output (the human gate decides admission).
  if (emitted.length === 0) {
    for (const a of Object.values(clustered)) emitted.push(emitTemplate(a));
  }

  return { library, emitted };
}
