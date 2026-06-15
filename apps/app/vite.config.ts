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
import { detectWorktreePrefix } from "./dev/detect-worktree-prefix";
import { createPortlessHttpsAgent } from "./dev/portless-https-agent";
import { linguiMacroBabelPlugin, shikiSsrExternalPlugin } from "./dev/vite-plugins";
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
    process.env.MERIDIAN_API_ORIGIN ??
    env.MERIDIAN_API_ORIGIN ??
    resolveApiDevOriginFallback(detectWorktreePrefix(repoRoot));
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
  };
});
