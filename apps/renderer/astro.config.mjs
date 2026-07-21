import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const siteUrl = process.env.SITE_URL ?? "https://example.com";
const outDir = process.env.OUT_DIR ?? "dist";

export default defineConfig({
  output: "static",
  site: siteUrl,
  outDir,
  build: { format: "directory" },
  integrations: [sitemap()],
  vite: {
    define: {
      "process.env.GYM_JSON": JSON.stringify(process.env.GYM_JSON ?? ""),
      "process.env.SITE_URL": JSON.stringify(siteUrl),
      "process.env.TEMPLATE": JSON.stringify(process.env.TEMPLATE ?? "modern"),
    },
  },
});
