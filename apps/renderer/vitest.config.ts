import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

/** Stub .astro files as empty default exports so Vitest can import registries. */
const astroStub: Plugin = {
  name: "astro-stub",
  resolveId(id) {
    if (id.endsWith(".astro")) return id;
  },
  load(id) {
    if (id.endsWith(".astro")) return "export default {}";
  },
};

export default defineConfig({
  plugins: [astroStub],
  test: {
    // Run test files sequentially — gates, lighthouse, and portability all do
    // full Astro builds and must not race over the dist/ directory.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
