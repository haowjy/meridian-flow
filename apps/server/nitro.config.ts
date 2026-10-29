import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "nitro/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoLogsGlob = `${path.join(repoRoot, "logs").replaceAll(path.sep, "/")}/**`;

/**
 * Bundles worker entries the way Vite does for the app: `new URL("./x.ts", import.meta.url)` in a
 * source file becomes an emitted chunk (with its imports bundled) and a URL to it. Nitro leaves the
 * expression alone, so the built server would look for `x.ts` beside its chunks and not find it.
 */
const WORKER_URL = /new URL\("(\.\/[^"]+\.ts)", import\.meta\.url\)/g;
const bundleWorkerEntries = {
  name: "bundle-worker-entries",
  transform(this: { emitFile(file: object): string }, code: string, id: string) {
    if (!code.includes("import.meta.url")) return null;
    return code.replace(WORKER_URL, (_match, relative: string) => {
      const entry = path.resolve(path.dirname(id), relative);
      const reference = this.emitFile({
        type: "chunk",
        id: entry,
        fileName: `workers/${path.basename(entry, ".ts")}.mjs`,
      });
      return `new URL(import.meta.ROLLUP_FILE_URL_${reference})`;
    });
  },
};

export default defineConfig({
  scanDirs: ["server"],
  experimental: { asyncContext: true },
  rolldownConfig: {
    plugins: [bundleWorkerEntries],
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
