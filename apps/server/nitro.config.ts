import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "nitro/config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const previewWorker = path.join(
  repoRoot,
  "apps/server/server/domains/file-intake/image-preview-worker.mjs",
);
const previewWorkerName = path.basename(previewWorker);

const repoLogsGlob = `${path.join(repoRoot, "logs").replaceAll(path.sep, "/")}/**`;

export default defineConfig({
  scanDirs: ["server"],
  experimental: { asyncContext: true },
  rolldownConfig: {
    plugins: [
      {
        // The preview worker is started by file path, so nothing imports it. Emitting it as
        // its own chunk bundles it and lets Nitro trace its native packages (sharp).
        name: "emit-image-preview-worker",
        buildStart() {
          // At the output root, where image-preview.ts finds it from `__nitro_main__`; a path
          // beside the chunk holding that file differs between `nitro dev` and a build.
          this.emitFile({ type: "chunk", id: previewWorker, fileName: previewWorkerName });
        },
      },
    ],
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
  // CommonJS packages that read `__dirname` (libheif's WASM loader) break when inlined into
  // the ESM worker chunk, so they stay external and are traced into the output.
  traceDeps: ["heic-decode", "libheif-js", "bmp-ts"],
  features: {
    websocket: true,
  },
});
