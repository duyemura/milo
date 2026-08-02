// All the semantic-layer types (Labels, SectionLabel, ElementLabel, AssetLabel,
// BrandDoc, SiteManifest, ManifestPage/Section/Element/Asset/CopyEntry) + the
// vocabularies (SECTION_ROLES, BRAND_COLOR_SLOTS, BRAND_FONT_SLOTS) live in types.ts.
export * from "./types.ts";
export { capture } from "./capture.ts";
export { project } from "./project.ts";
export { buildSite } from "./orchestrate.ts";
// A+B public API: labeling (heuristic + LLM + entry-point) and the manifest/brand builders.
export { label, heuristicLabels, llmLabels, buildDigest, LabelSchema } from "./labels.ts";
export type { Digest } from "./labels.ts";
export { buildManifest } from "./manifest.ts";
export type { BuildManifestArgs } from "./manifest.ts";
export { buildBrand, brandSlotOfCanon, deriveVariants, flattenRoot, canon } from "./brand.ts";
// Call-site option/result types live in the impl files — re-export them so
// consumers can type their calls without reaching into deep paths.
export type { CaptureOpts } from "./capture.ts";
export type { ProjectOpts, ProjectResult } from "./project.ts";
export type { PageSpec, BuildSiteOpts, BuildSiteResult } from "./orchestrate.ts";
// deploy is a CLI-only concern (needs env + AWS creds); intentionally not re-exported as a library API.
// Crawl + report are build-tooling utilities.
export { crawlSite } from "./crawl.ts";
export type { BuildReport, PageReport, PageTiming, PageLlmUsage, PageIssues } from "./report.ts";
export { generateHtmlReport } from "./report.ts";
export { discoverPages, originSlug, pageDir } from "./discover.ts";
export type { DiscoverOpts, DiscoverResult } from "./discover.ts";
export { buildSiteAuto } from "./orchestrate.ts";
export type { BuildSiteAutoOpts, BuildSiteAutoResult } from "./orchestrate.ts";
// Subsystem C — LLM-driven per-site edit operations, verifier-gated, self-correcting, reversible.
// Namespaced under `edit` to avoid collisions with engine-level types (SiteManifest, BrandDoc, etc.).
export * as edit from "./edit/index.ts";
