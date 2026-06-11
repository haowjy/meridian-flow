import path from "node:path";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    server: {
      host: "127.0.0.1",
      port: Number(process.env.PORT) || 3000,
      allowedHosts: [".localhost", ".ts.net"],
    },
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [tanstackStart(), viteReact(), ...(process.env.VITEST ? [] : [nitro()])],
    envDir: repoRoot,
  };
});
