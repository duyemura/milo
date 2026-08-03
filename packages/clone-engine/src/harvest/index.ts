export * from "./types.ts";
export * from "./fingerprint.ts";
export * from "./extract.ts";
export * from "./knobs.ts";
export * from "./residual.ts";
// Note: swapBrandOracle from classify.ts is intentionally NOT re-exported here.
// It is not yet wired into the pipeline (the current swap-brand check is CSS-literal-only,
// via offBrandLiterals). It stays in classify.ts for future full pixel-render integration.
export { offBrandLiterals, classifyByResidual } from "./classify.ts";
export * from "./library.ts";
export * from "./promote.ts";
export * from "./emit.ts";
export * from "./harvest.ts";
