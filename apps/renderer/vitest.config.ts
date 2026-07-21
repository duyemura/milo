import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run test files sequentially — gates, lighthouse, and portability all do
    // full Astro builds and must not race over the dist/ directory.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
