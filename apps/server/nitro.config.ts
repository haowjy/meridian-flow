import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "nitro/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

try {
  loadEnvFile(path.join(repoRoot, ".env"));
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

export default defineConfig({
  scanDirs: ["server"],
  watchOptions: {
    ignored: ["**/logs/**"],
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
});
