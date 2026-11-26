import path from "node:path";
import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";
import { architectureMapPlugin } from "../../tools/architecture-map/vite-plugin.mjs";
import { resolveReleaseId } from "../../tools/release/release-id.mjs";

import { apiHttpDevProxyPlugin } from "./dev/api-http-dev-proxy-plugin";
import { linguiMacroBabelPlugin } from "./dev/vite-plugins";
import { readOptionalEnvString } from "./src/core/env";
import { APP_SSR_NO_EXTERNAL } from "./src/server/ssr-no-external";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoLogsDir = path.join(repoRoot, "logs");

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  // keep: whatever starts the dev server names the API server (`pnpm dev` does). Builds and tests serve no requests, so they run without one
  const apiDevOrigin = readOptionalEnvString(process.env.MERIDIAN_API_ORIGIN);
  if (command === "serve" && !process.env.VITEST && !apiDevOrigin) {
    throw new Error(
      "MERIDIAN_API_ORIGIN is not set. Start the app with `pnpm dev`, which sets it.",
    );
  }

  return {
    server: {
      host: "127.0.0.1",
      port: Number(process.env.PORT) || 3000,
      watch: {
        ignored: (watchedPath) =>
          watchedPath === repoLogsDir || watchedPath.startsWith(`${repoLogsDir}${path.sep}`),
      },
      strictPort: true,
      allowedHosts: [".localhost", ".ts.net"],
      proxy: apiDevOrigin
        ? {
            // keep: no `changeOrigin`; the server's dev sign-in rule compares Origin with the Host the browser sent
            "/api/threads/ws": { target: apiDevOrigin, ws: true },
            "/ws/loro": { target: apiDevOrigin, ws: true },
          }
        : undefined,
    },
    resolve: {
      dedupe: ["loro-crdt"],
      alias: [
        // keep: One loro-crdt instance for app and packages; instanceof LoroMap depends on it
        { find: /^loro-crdt$/, replacement: "loro-crdt/base64" },
      ],
      tsconfigPaths: true,
    },
    plugins: [
      ...(apiDevOrigin ? [apiHttpDevProxyPlugin(apiDevOrigin)] : []),
      architectureMapPlugin(path.join(repoRoot, ".context/system-architecture/map.config.mjs")),
      linguiMacroBabelPlugin(),
      tailwindcss(),
      tanstackStart({
        router: {
          routeTreeFileHeader: ["/* eslint-disable */", "// noinspection JSUnusedGlobalSymbols"],
        },
      }),
      viteReact(),
      lingui(),
      ...(process.env.VITEST ? [] : [nitro()]),
    ],
    environments: {
      ssr: {
        resolve: {
          noExternal: APP_SSR_NO_EXTERNAL,
        },
      },
    },
    define: {
      __MERIDIAN_RELEASE__: JSON.stringify(resolveReleaseId({ dev: command === "serve" })),
    },
    envDir: repoRoot,
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules")) {
              if (id.includes("@tiptap") || id.includes("prosemirror-")) {
                return "editor-tiptap";
              }
              if (id.includes("loro-crdt") || id.includes("loro-protocol")) {
                return "collab-loro";
              }
            }
          },
        },
      },
    },
  };
});
