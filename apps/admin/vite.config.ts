import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 4101,
    proxy: {
      "/api": "http://127.0.0.1:4100",
      "/auth": "http://127.0.0.1:4100",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
