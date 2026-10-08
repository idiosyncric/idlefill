import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Dev-only: read the INSTALLED client's config (the same file the launchd
// daemon loads, same candidate order as client/src/config.ts) so `npm run
// dev` follows the live deployment automatically: the proxy targets the
// server_url that client points at, and its arbiter token is served to the
// page at /__idlefill-dev-config so no pasting is needed. IDLEFILL_API /
// IDLEFILL_CLIENT_CONFIG env overrides still win. This whole block runs at
// config load ONLY in the dev toolchain — a production build bakes none of
// it in, and the middleware never exists there.
type ClientConfig = { server_url?: unknown; token?: unknown };

function readClientConfig(): ClientConfig | null {
  const envRaw = process.env.IDLEFILL_CLIENT_CONFIG?.trim();
  if (envRaw) {
    try {
      return JSON.parse(envRaw) as ClientConfig;
    } catch {
      return null;
    }
  }
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const cand of [resolve(here, "../client/config.json"), resolve(here, "../client/config.client.json")]) {
    if (existsSync(cand)) {
      try {
        return JSON.parse(readFileSync(cand, "utf-8")) as ClientConfig;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Serve-mode middleware exposing { server_url, token } for the dev page.
// Loopback dev tooling only — the same trust level as reading the gitignored
// config file in a terminal.
function devConfigBridge(cfg: ClientConfig | null) {
  return {
    name: "idlefill-dev-config",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/__idlefill-dev-config", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(
          JSON.stringify({
            server_url: typeof cfg?.server_url === "string" ? cfg.server_url : null,
            token: typeof cfg?.token === "string" ? cfg.token : null,
          }),
        );
      });
    },
  };
}

// command === "serve" is the dev server ONLY. The header's "copy url" is
// the value an agent's server_url needs, and on :5273 the page's own origin
// is the Vite dev server, not the arbiter — so dev bakes the proxy target
// in. A production build (the arbiter serves dist/ itself) bakes null and
// falls back to location.origin, which is then the serving arbiter's real
// origin — a build-time constant could never name the tailnet origin the
// page is actually reached on.
// Dev reads the installed client's config once at startup for the default
// proxy target; the http-proxy `router` re-reads it per request so a changed
// server_url takes effect without restarting Vite.
export default defineConfig(({ command }) => {
  const clientCfg = command === "serve" ? readClientConfig() : null;
  const clientUrl = typeof clientCfg?.server_url === "string" ? clientCfg.server_url : null;
  const API = process.env.IDLEFILL_API ?? clientUrl ?? "http://127.0.0.1:8787";
  return {
    plugins: [react(), tailwindcss(), ...(command === "serve" ? [devConfigBridge(clientCfg)] : [])],
    clearScreen: false,
    envPrefix: ["VITE_"],
    define: { __IDLEFILL_DEV_API__: JSON.stringify(command === "serve" ? API : null) },
    server: {
      port: 5273,
      strictPort: true,
      proxy: {
        "/api": {
          target: API,
          changeOrigin: false,
          // Re-read the client config per request: the live deployment's
          // server_url wins over the startup snapshot.
          router: () => process.env.IDLEFILL_API ?? readClientConfig()?.server_url ?? API,
        },
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
  };
});
