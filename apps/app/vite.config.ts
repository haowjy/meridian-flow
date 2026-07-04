import type { IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

import { apiHttpDevProxyPlugin } from "./dev/api-http-dev-proxy-plugin";
import { createPortlessHttpsAgent, resolvePortlessServerOrigin } from "./dev/portless-dev-helpers";
import { linguiMacroBabelPlugin, shikiSsrExternalPlugin } from "./dev/vite-plugins";
import { readOptionalEnvString } from "./src/core/env";
import {
  resolveApiDevOriginFallback,
  resolveApiDevOriginForAppHost,
} from "./src/core/transport/dev-transport";
import { APP_SSR_EXTERNAL, APP_SSR_NO_EXTERNAL } from "./src/server/ssr-no-external";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  const apiDevOrigin =
    readOptionalEnvString(process.env.MERIDIAN_API_ORIGIN) ??
    readOptionalEnvString(env.MERIDIAN_API_ORIGIN) ??
    resolvePortlessServerOrigin(repoRoot) ??
    resolveApiDevOriginFallback();
  const portlessHttpsAgent = createPortlessHttpsAgent();

  return {
    server: {
      host: "127.0.0.1",
      port: Number(process.env.PORT) || 3000,
      allowedHosts: [".localhost", ".ts.net"],
      proxy: {
        "/api/threads/ws": {
          target: apiDevOrigin,
          changeOrigin: true,
          ws: true,
          agent: portlessHttpsAgent,
          router: (req: IncomingMessage) =>
            resolveApiDevOriginForAppHost(req.headers.host ?? "", apiDevOrigin),
        },
        "/ws/yjs": {
          target: apiDevOrigin,
          changeOrigin: true,
          ws: true,
          agent: portlessHttpsAgent,
          router: (req: IncomingMessage) =>
            resolveApiDevOriginForAppHost(req.headers.host ?? "", apiDevOrigin),
        },
      },
    },
    resolve: {
      dedupe: ["yjs", "y-protocols", "y-prosemirror", "@tiptap/y-tiptap"],
      alias: {
        eventemitter3: path.resolve(repoRoot, "apps/app/src/client/shims/eventemitter3.ts"),
      },
      tsconfigPaths: true,
    },
    plugins: [
      shikiSsrExternalPlugin(),
      apiHttpDevProxyPlugin(apiDevOrigin, portlessHttpsAgent),
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
          external: APP_SSR_EXTERNAL,
        },
      },
    },
    envDir: repoRoot,
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules")) {
              if (
                id.includes("yjs") ||
                id.includes("y-protocols") ||
                id.includes("y-prosemirror")
              ) {
                return "collab-yjs";
              }
              if (id.includes("@tiptap") || id.includes("prosemirror-")) {
                return "editor-tiptap";
              }
              if (id.includes("@hocuspocus")) {
                return "collab-transport";
              }
            }
          },
        },
      },
    },
  };
});
