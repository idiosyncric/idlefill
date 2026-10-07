import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";

// Multi-entry build: the two bundled views the Rust side addresses by
// name — WebviewUrl::App("index.html") (settings) and
// WebviewUrl::App("glance.html") (the glance window, lib.rs). Output
// lands in tauri/settings-ui (frontendDist). base "./" so the assets
// resolve under Tauri's tauri:// custom protocol (relative URLs).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    outDir: resolve(__dirname, "../settings-ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: resolve(__dirname, "index.html"),
        glance: resolve(__dirname, "glance.html"),
      },
    },
  },
});
