import { z } from "zod";

export interface SiteRef { dir: string; }              // a projected OUT dir (from project())

export type EditOp =
  | { op: "editCopy"; copyKey: string; text: string }
  | { op: "setBrand"; slot: "primary" | "accent" | "surface" | "text" | "muted"; value: string }
  | { op: "swapAsset"; alias: string; source: string }  // source = file path or URL of the new asset
  | { op: "styleTweak"; target: string; prop: string; value: string }  // target = data-role or section; prop ∈ STYLE_PROPS
  | { op: "removeSection"; section: string }            // section = data-section role or component name
  | { op: "reorderSection"; section: string; toIndex: number }
  | { op: "addSection"; cloneOf: string; afterSection?: string }
  | { op: "addPage"; route: string; cloneOfPage?: string };  // cloneOfPage optional → auto-pick nearest-type

export interface OpResult { op: EditOp; changedFiles: string[]; targetSections: string[]; }

export interface PlanResult {
  needsInfo: boolean;
  questions?: string[];               // present when needsInfo
  ops?: EditOp[]; summary?: string;   // present when ready (needsInfo === false)
}

export interface SectionDiff { section: string; changed: boolean; inScopePx: number; outScopePx: number; }

export interface VerifierReport {
  pass: boolean;
  sections: SectionDiff[];
  structural: { expected: string[]; actual: string[]; ok: boolean };
  renderSane: boolean;
  failures: string[];                 // human-readable reasons (fed to self-correction)
}

export interface EditResult { ok: boolean; verifierReport: VerifierReport; opsApplied: EditOp[]; reverted?: boolean; }

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
  z.object({ op: z.literal("setBrand"), slot: BrandSlotZ, value: z.string() }),
  z.object({ op: z.literal("swapAsset"), alias: z.string(), source: z.string() }),
  z.object({ op: z.literal("styleTweak"), target: z.string(), prop: StylePropZ, value: z.string() }),
  z.object({ op: z.literal("removeSection"), section: z.string() }),
  z.object({ op: z.literal("reorderSection"), section: z.string(), toIndex: z.number().int().nonnegative() }),
  z.object({ op: z.literal("addSection"), cloneOf: z.string(), afterSection: z.string().optional() }),
  z.object({ op: z.literal("addPage"), route: z.string(), cloneOfPage: z.string().optional() }),
]);

/** The full PlanResult schema for the LLM to fill (needsInfo=true XOR needsInfo=false). */
export const PlanSchema = z.discriminatedUnion("needsInfo", [
  z.object({
    needsInfo: z.literal(true),
    questions: z.array(z.string()).min(1).max(3),
  }),
  z.object({
    needsInfo: z.literal(false),
    ops: z.array(EditOpSchema).min(1),
    summary: z.string(),
  }),
]);

export type PlanSchemaOutput = z.infer<typeof PlanSchema>;
