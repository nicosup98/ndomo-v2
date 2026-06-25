import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)), // ./web/ — where index.html lives
  plugins: [vue()],
  // Output to src/http/web/ so Elysia can serve as static SPA (single-port topology)
  build: {
    outDir: fileURLToPath(new URL("../src/http/web/", import.meta.url)),
    emptyOutDir: true,
    target: "esnext",
    sourcemap: false,
  },
  // base: './' critical for SPA served from arbitrary path (sub-paths, reverse proxies)
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Vite dev proxies /api/* to Elysia at 4097 — avoids CORS preflight during dev
    proxy: {
      "/api": {
        target: "http://localhost:4097",
        changeOrigin: true,
      },
    },
  },
});
