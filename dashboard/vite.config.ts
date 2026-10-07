import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The dashboard talks to the arbiter's API. Dev: Vite proxies /api to the
// running arbiter (default 8787, override with IDLEFILL_API). Prod: the
// arbiter serves the built assets itself (same origin, no CORS).
const API = process.env.IDLEFILL_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  envPrefix: ["VITE_"],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": { target: API, changeOrigin: false },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
