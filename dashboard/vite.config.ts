import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The dashboard talks to the arbiter's API. Dev: Vite proxies /api to the
// running arbiter (default 8787, override with IDLEFILL_API). Prod: the
// arbiter serves the built assets itself (same origin, no CORS).
const API = process.env.IDLEFILL_API ?? "http://127.0.0.1:8787";

// command === "serve" is the dev server ONLY. The header's "copy url" is
// the value an agent's server_url needs, and on :5273 the page's own origin
// is the Vite dev server, not the arbiter — so dev bakes the proxy target
// in. A production build (the arbiter serves dist/ itself) bakes null and
// falls back to location.origin, which is then the serving arbiter's real
// origin — a build-time constant could never name the tailnet origin the
// page is actually reached on.
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  envPrefix: ["VITE_"],
  define: { __IDLEFILL_DEV_API__: JSON.stringify(command === "serve" ? API : null) },
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
}));
