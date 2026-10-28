import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "nitro/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoLogsGlob = `${path.join(repoRoot, "logs").replaceAll(path.sep, "/")}/**`;

export default defineConfig({
  scanDirs: ["server"],
  experimental: { asyncContext: true },
  rolldownConfig: {
    watch: {
      // pnpm store files are hardlinked across worktrees, so an install in a
      // sibling worktree changes their ctime (inotify IN_ATTRIB) and would
      // rebuild this server mid-turn.
      exclude: [repoLogsGlob, "**/node_modules/**"],
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
});
