import path from "node:path";
import type { AdminConfig } from "../config.ts";

/**
 * A site's on-disk layout under the admin data dir. One source of truth for the
 * runner (writes) and the workbench routes (serve). `full-site/` is the clone
 * engine's multi-page output (buildSiteAuto assembles it at `--cwd`); `dist/` is a
 * copy the preview route serves and deploy reuses; the report pair sits in `seed/`.
 */
export function sitePaths(config: AdminConfig, siteId: string): {
  dir: string;
  seedDir: string;
  distDir: string;
  fullSiteDir: string;
  reportHtml: string;
  reportJson: string;
} {
  const dir = path.join(config.dataDir, "sites", siteId);
  const seedDir = path.join(dir, "seed");
  return {
    dir,
    seedDir,
    distDir: path.join(dir, "dist"),
    fullSiteDir: path.join(seedDir, "full-site"),
    reportHtml: path.join(seedDir, "build-report.html"),
    reportJson: path.join(seedDir, "build-report.json"),
  };
}
