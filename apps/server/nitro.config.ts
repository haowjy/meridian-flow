import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "nitro/config";
import { installNitroDevShutdown } from "./server/lib/nitro-dev-shutdown.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoLogsGlob = `${path.join(repoRoot, "logs").replaceAll(path.sep, "/")}/**`;

try {
  loadEnvFile(path.join(repoRoot, ".env"));
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

export default defineConfig({
  scanDirs: ["server"],
  experimental: { asyncContext: true },
  rolldownConfig: {
    watch: {
      exclude: [repoLogsGlob],
    },
  },
  // Interrupt envelope handler runs before Nitro's built-in JSON wrapper so HTTP bodies
  // match WS error frames for `throwHttpInterrupt*` failures.
  errorHandler: ["./server/lib/interrupt-error-handler.ts"],
  serverAssets: [
    {
      baseName: "builtin",
      dir: path.join(repoRoot, "apps/server/server/domains/packages/builtin"),
    },
  ],
  features: {
    websocket: true,
  },
  hooks: {
    compiled(nitro) {
      // Close Nitro on a dev signal. The patched worker runner asks the runtime
      // to close and awaits its application drain before terminating the thread.
      if (
        process.env.NODE_ENV === "development" &&
        process.argv[2] === "dev" &&
        process.argv[1]?.endsWith("/nitro/dist/cli/index.mjs")
      ) {
        installNitroDevShutdown(nitro);
      }
    },
  },
});
