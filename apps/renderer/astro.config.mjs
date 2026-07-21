import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const siteUrl = process.env.SITE_URL ?? "https://example.com";

export default defineConfig({
  output: "static",
  site: siteUrl,
  build: { format: "directory" },
  integrations: [sitemap()],
  vite: {
    define: {
      "process.env.GYM_JSON": JSON.stringify(process.env.GYM_JSON ?? ""),
      "process.env.SITE_URL": JSON.stringify(siteUrl),
    },
  },
});
