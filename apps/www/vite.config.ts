import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { applyDevEnvToProcess } from "../../tools/dev/lib/dev-env";

export default defineConfig(({ command }) => {
  // `pnpm dev` already passes env through tmux; this covers a direct `vite dev`.
  if (command === "serve") applyDevEnvToProcess();
  return {
    server: {
      host: "127.0.0.1",
      port: Number(process.env.PORT) || 3000,
      // Bind exactly the port portless proxies to (PORT), never Vite's silent
      // auto-increment fallback — drifting off it desyncs the proxy route on
      // restart (502) and orphans the listener. Fail fast if the port is held.
      strictPort: true,
      allowedHosts: [".localhost", ".ts.net"],
    },
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [
      tailwindcss(),
      tanstackStart({
        srcDirectory: "src",
      }),
      viteReact(),
      nitro(),
    ],
  };
});
