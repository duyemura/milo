import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  vite: {
    resolve: {
      alias: {
        "@templates": fileURLToPath(new URL("../../templates", import.meta.url)),
      },
    },
    server: {
      fs: {
        allow: [fileURLToPath(new URL("../..", import.meta.url))],
      },
    },
  },
});
