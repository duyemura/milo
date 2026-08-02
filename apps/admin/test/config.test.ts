import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

describe("loadConfig dataDir", () => {
  // Regression guard: the clone-engine subprocess is spawned with cwd=repoRoot and writes
  // into dataDir, while the admin process creates it. A relative dataDir resolves against
  // each cwd differently → ENOENT. dataDir must always be absolute and anchored at repoRoot.
  it("resolves the default relative dataDir to an absolute path under repoRoot", () => {
    const config = loadConfig({ DB_PATH: ":memory:" } as NodeJS.ProcessEnv);
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(config.dataDir).toBe(path.join(REPO_ROOT, "admin-data"));
  });

  it("anchors a relative DATA_DIR override to repoRoot", () => {
    const config = loadConfig({ DB_PATH: ":memory:", DATA_DIR: "./scratch/data" } as NodeJS.ProcessEnv);
    expect(config.dataDir).toBe(path.join(REPO_ROOT, "scratch", "data"));
  });

  it("preserves an absolute DATA_DIR override as-is", () => {
    const abs = "/tmp/milo-admin-data";
    const config = loadConfig({ DB_PATH: ":memory:", DATA_DIR: abs } as NodeJS.ProcessEnv);
    expect(config.dataDir).toBe(abs);
  });
});
