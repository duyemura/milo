import type { z } from "zod";
import type { StyleMap, TreeEl } from "../types.ts";
import type { TemplateSectionRole, SectionTemplate } from "../edit/templates.ts";

/** Coarse arrangement primitive — part of the fingerprint identity (NOT a knob). */
export type LayoutPrimitive = "stack" | "grid" | "split" | "overlay" | "alternating";

/** Cardinality class of a slot: exactly-one, or a repeating group of >=2. */
export type Cardinality = "1" | "N";

/**
 * One node in a section's semantic slot tree. `role` is the slot's semantic name
 * (headline, subcopy, cta, media, form, feature-item, ...). `card` collapses repetition
 * (a grid of 3 cards and a grid of 6 cards share the same tree). `children` is the ordered
 * sub-slots of a repeating group (e.g. a card's {title, body}).
 */
export interface SlotNode {
  role: string;
  card: Cardinality;
  children?: SlotNode[];
}

/** The bounded knob set an archetype supports. Every value is an enum or a bounded int — never a raw literal. */
export interface KnobSet {
  mediaType: Array<"image" | "video" | "none">;
  mediaPosition: Array<"left" | "right" | "background">;
  align: Array<"left" | "center" | "right">;
  density: Array<"compact" | "default" | "roomy">;
  /** Supported item-count range for the archetype's N-cardinality slot (inclusive). */
  itemCount: { min: number; max: number };
}

/** The structural identity of a section. Two sections with equal `hash` ARE the same template. */
export interface Fingerprint {
  role: TemplateSectionRole;
  slotTree: SlotNode[];
  layoutPrimitive: LayoutPrimitive;
  /** Stable content hash of the three fields above. */
  hash: string;
}

/**
 * A single harvested section instance: its source, role, extracted structure, and its
 * brand-tokenized styles (produced by the tokenizer during harvest). This is the unit the
 * classifier, fingerprinter, and dedup operate on.
 */
export interface HarvestedSection {
  /** Origin site id (a stable slug, e.g. "vervecoffee"). Popularity counts distinct sourceSite. */
  sourceSite: string;
  role: TemplateSectionRole;
  slotTree: SlotNode[];
  layoutPrimitive: LayoutPrimitive;
  /** The section's captured computed styles at 1440 (id -> prop -> value), pre-tokenization. */
  styles: StyleMap;
  /** The captured subtree root for the section (for the swap-brand render + knob reading). */
  node: TreeEl;
  /** Observed knob values on THIS instance (used to seed the archetype's knob defaults). */
  observed: {
    mediaType: "image" | "video" | "none";
    mediaPosition: "left" | "right" | "background";
    align: "left" | "center" | "right";
    itemCount: number;
  };
}

export type ClassifyVerdict = "adaptive" | "reject";

/** The classifier's output for one section. `residual` is the measured [0,1] bespoke-styling score. */
export interface Classification {
  verdict: ClassifyVerdict;
  residual: number;
  /** true only when residual<=threshold AND the swap-brand oracle passed on every swap target. */
  swapBrandClean: boolean;
  /** Human-readable reasons (fed to the harvest report / human gate). */
  reasons: string[];
}

/** One clustered archetype: a fingerprint, its members, its popularity, and its enumerated knobs. */
export interface Archetype {
  fingerprint: Fingerprint;
  /** Distinct source-site slugs contributing to this archetype (popularity = size of this set). */
  sites: string[];
  knobs: KnobSet;
  /** Knob defaults = modal observed value across members. */
  knobDefaults: { mediaType: string; mediaPosition: string; align: string; itemCount: number };
  /** Governance state (see promote.ts). */
  status: "quarantine" | "candidate" | "admitted";
}

/** One row in harvest-report.json — the human-gate's evidence. */
export interface HarvestReportEntry {
  sourceSite: string;
  role: string;
  fingerprintHash: string;
  residual: number;
  swapBrandClean: boolean;
  /** Popularity of the archetype this instance landed in, at report time. */
  popularity: number;
  knobs: KnobSet;
  verdict: ClassifyVerdict;
}

/** The persisted library: archetypes keyed by fingerprint hash + a report log. */
export interface LibraryStore {
  version: 1;
  archetypes: Record<string, Archetype>;
  report: HarvestReportEntry[];
}

/** A template emitted from an archetype, ready to register in the E-v1 library. */
export interface EmittedTemplate {
  /** The archetype's fingerprint hash — the emitted template's stable id. */
  id: string;
  role: TemplateSectionRole;
  /** The templates.ts source string (a full `SectionTemplate` literal) for review/commit. */
  source: string;
  /** The runtime template object (same shape E-v1 registers), for in-process integration tests. */
  template: SectionTemplate;
}

/** A schema-typed alias kept local so later files don't re-derive it. */
export type Zod = z.ZodTypeAny;
