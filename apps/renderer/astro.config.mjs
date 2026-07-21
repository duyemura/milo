import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  build: { format: "directory" },
  vite: {
    define: {
      "process.env.GYM_JSON": JSON.stringify(process.env.GYM_JSON ?? ""),
    },
  },
});
