export * from "./types.ts";
export { capture } from "./capture.ts";
export { project } from "./project.ts";
export { buildSite } from "./orchestrate.ts";
export { label, heuristicLabels, LabelSchema } from "./labels.ts";
// Call-site option/result types live in the impl files — re-export them so
// consumers can type their calls without reaching into deep paths.
export type { CaptureOpts } from "./capture.ts";
export type { ProjectOpts, ProjectResult } from "./project.ts";
export type { PageSpec, BuildSiteOpts, BuildSiteResult } from "./orchestrate.ts";
// deploy is a CLI-only concern (needs env + AWS creds); intentionally not re-exported as a library API.
