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
