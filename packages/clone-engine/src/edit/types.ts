import { z } from "zod";
import type { PageType, PageGoal } from "../types.ts";

export interface SiteRef { dir: string; }              // a projected OUT dir (from project())

export type EditOp =
  | { op: "editCopy"; copyKey: string; text: string }
  | { op: "setBrand"; slot: "primary" | "accent" | "surface" | "text" | "muted"; value: string }
  | { op: "swapAsset"; alias: string; source: string }  // source = file path or URL of the new asset
  | { op: "styleTweak"; target: string; prop: StyleProp; value: string }  // target = data-role or section; prop ∈ STYLE_PROPS
  | { op: "removeSection"; section: string }            // section = data-section role or component name
  | { op: "reorderSection"; section: string; toIndex: number }
  | { op: "addSection"; cloneOf: string; afterSection?: string }
  | { op: "addPage"; route: string; cloneOfPage?: string; pageType?: PageType };  // cloneOfPage optional → auto-pick nearest-type; pageType optional → classify from route

export interface OpResult { op: EditOp; changedFiles: string[]; targetSections: string[]; }

/**
 * The planner result — a proper discriminated union derived from PlanSchema (source of truth).
 * Either `needsInfo: true` with clarifying questions, OR `needsInfo: false` with the validated
 * ops + summary (+ any ops that were dropped as hallucinated, so the caller can surface a partial
 * edit rather than reporting full success). The XOR is enforced by the schema, not by optionality.
 */
export type PlanResult = z.infer<typeof PlanSchema>;

export interface SectionDiff { section: string; changed: boolean; inScopePx: number; outScopePx: number; }

export interface VerifierReport {
  pass: boolean;
  sections: SectionDiff[];
  structural: { expected: string[]; actual: string[]; ok: boolean };
  renderSane: boolean;
  failures: string[];                 // human-readable reasons (fed to self-correction)
}

export interface EditResult { ok: boolean; verifierReport: VerifierReport; opsApplied: EditOp[]; reverted?: boolean; }

/** The edit's declared intent: which sections it meant to touch, and the op that did it. */
export interface EditIntent {
  /** data-component names (or section roles) the edit was allowed to change. */
  editedSections: string[];
  op: EditOp;
  /** setBrand only: the before/after hex of the recolored slot (drives the delta-vector scope). */
  brandRecolor?: { oldHex: string; newHex: string };
  /**
   * Element-targeted ops (editCopy/styleTweak/swapAsset): a CSS selector for the edited ELEMENT
   * (e.g. the manifest element selector, or `[data-copy="Key"]`). When present, the verifier
   * sub-scopes the edited section to this element's box — changed pixels INSIDE the section but
   * OUTSIDE the element box are flagged as intra-section collateral. Omit for a whole-section trust.
   */
  elementSelector?: string;
  /**
   * REFLOW ops (removeSection/reorderSection): the caller declares the intended post-edit section
   * order by name. When provided, the structural check uses this as the expected order instead of
   * deriving it heuristically — the op declares what it intended and the verifier confirms both the
   * rendered DOM and site.json match. This makes the check non-circular: the op is the authority,
   * the verifier is the confirmation. Omit to keep the current default behavior (backward-compat).
   */
  expectedSectionOrder?: string[];
}

/** Bounded property set styleTweak is allowed to change (keeps local styling predictable). */
export const STYLE_PROPS = [
  "font-size","font-weight","font-style","text-align","padding","margin",
  "background-color","color","width","max-width","display","grid-template-columns","gap",
] as const;
export type StyleProp = (typeof STYLE_PROPS)[number];

// ---------------------------------------------------------------------------
// SiteDigest — compact token-budgeted site view for the planner prompt
// ---------------------------------------------------------------------------

/** A single copy slot preview included in the site digest. */
export interface DigestCopyEntry {
  key: string;
  /** Truncated text preview, max 60 chars. */
  preview: string;
}

/** Compact representation of one section on one page. */
export interface DigestSection {
  name: string;
  role: string;
  /** All copy slots owned by this section, with short previews. */
  copyKeys: DigestCopyEntry[];
  /** Element roles inside this section. */
  elementRoles: string[];
  /** Asset aliases that reference this section (inferred from manifest). */
  assetAliases: string[];
}

/** Compact representation of one page. */
export interface DigestPage {
  route: string;
  /** Page type from the gym-site taxonomy (subsystem D). */
  type: PageType;
  /** Goal of the page — drives editing conventions (C) and measurement (F). */
  goal: PageGoal;
  sections: DigestSection[];
}

/** Brand slot names and their current hex colors. */
export interface DigestBrand {
  primary: string;
  accent: string;
  surface: string;
  text: string;
  muted: string;
}

/**
 * Token-budgeted site view passed to the planner LLM.
 * Keep it small — this goes in the system/user prompt.
 */
export interface SiteDigest {
  pages: DigestPage[];
  brand: DigestBrand;
  /** All asset aliases across all pages (deduplicated). */
  assetAliases: string[];
}

// ---------------------------------------------------------------------------
// ConversationTurn — single dialogue turn for the planner
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// EditOpSchema — Zod discriminated union mirroring EditOp (8 variants)
// Reusable by T8 (apply phase) to parse plan output safely.
// ---------------------------------------------------------------------------

const StylePropZ = z.enum([
  "font-size", "font-weight", "font-style", "text-align", "padding", "margin",
  "background-color", "color", "width", "max-width", "display",
  "grid-template-columns", "gap",
]);

const BrandSlotZ = z.enum(["primary", "accent", "surface", "text", "muted"]);

export const EditOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("editCopy"), copyKey: z.string(), text: z.string() }),
  z.object({ op: z.literal("setBrand"), slot: BrandSlotZ, value: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
  z.object({ op: z.literal("swapAsset"), alias: z.string(), source: z.string() }),
  z.object({ op: z.literal("styleTweak"), target: z.string(), prop: StylePropZ, value: z.string() }),
  z.object({ op: z.literal("removeSection"), section: z.string() }),
  z.object({ op: z.literal("reorderSection"), section: z.string(), toIndex: z.number().int().nonnegative() }),
  z.object({ op: z.literal("addSection"), cloneOf: z.string(), afterSection: z.string().optional() }),
  z.object({
    op: z.literal("addPage"),
    route: z.string(),
    cloneOfPage: z.string().optional(),
    pageType: z.enum(["home", "pillar", "content", "conversion", "utility"]).optional(),
  }),
]);

/**
 * The full PlanSchema (needsInfo=true XOR needsInfo=false). Also the source of truth for
 * `PlanResult` (a discriminated union — no XOR-via-optionality).
 *
 * The LLM only ever fills the raw shape (questions OR ops+summary). `dropped` is NOT LLM output:
 * it's populated post-hoc by plan.ts when it drops a hallucinated op, so the caller can surface a
 * PARTIAL edit ("I couldn't apply X — only Y will change") instead of reporting full success. It
 * is `.optional()` so a plan with no drops stays exactly the shape the LLM produced.
 */
export const PlanSchema = z.discriminatedUnion("needsInfo", [
  z.object({
    needsInfo: z.literal(true),
    questions: z.array(z.string()).min(1).max(3),
  }),
  z.object({
    needsInfo: z.literal(false),
    ops: z.array(EditOpSchema).min(1),
    summary: z.string(),
    dropped: z.array(z.object({ op: z.unknown(), reason: z.string() })).optional(),
  }),
]);

export type PlanSchemaOutput = z.infer<typeof PlanSchema>;
