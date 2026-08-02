// Types — EditOp, EditOpSchema, PlanResult, EditResult, VerifierReport, SectionDiff,
//         SiteRef, ConversationTurn, SiteDigest + sub-types, STYLE_PROPS, StyleProp, etc.
export * from "./types.ts";

// Target resolvers (resolveCopy, resolveSection, resolveAsset, resolveElement, TargetError, loadSite).
export * from "./target.ts";

// Deterministic edit operations (editCopy, setBrand, swapAsset, styleTweak,
// removeSection, reorderSection, addSection, addPage, pickTemplatePage).
export * from "./ops.ts";

// Reversible history (snapshot, restore, revert).
export * from "./history.ts";

// Token-budgeted site view (digest).
export * from "./digest.ts";

// LLM planner (plan → PlanResult).
export * from "./plan.ts";

// Self-correcting apply loop (apply, reviseOps) + EditIntent from verify.
export * from "./apply.ts";
export type { EditIntent } from "./verify.ts";

// Snapshot render (renderSnapshot, sectionListOf) + RenderSnapshot type.
export { renderSnapshot, sectionListOf } from "./snapshot.ts";
export type { RenderSnapshot } from "./snapshot.ts";

// Verifier (verify, cropDiffPx, currentBrandHex).
export { verify, cropDiffPx, currentBrandHex } from "./verify.ts";
