import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "nitro/config";
import { resolveReleaseId } from "../../tools/release/release-id.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const repoLogsGlob = `${path.join(repoRoot, "logs").replaceAll(path.sep, "/")}/**`;

// keep: Nitro leaves `new URL("./x.ts", import.meta.url)` alone, so a worker entry would not resolve in a build; this rewrites it to an emitted chunk
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
  replace: {
    __MERIDIAN_RELEASE__: JSON.stringify(
      resolveReleaseId({ dev: process.env.NODE_ENV === "development" }),
    ),
  },
  experimental: { asyncContext: true },
  rolldownConfig: {
    plugins: [bundleWorkerEntries],
    watch: {
      // keep: pnpm store files are hardlinked, so a sibling worktree's install changes their ctime and would rebuild this server mid-turn
      exclude: [repoLogsGlob, "**/node_modules/**"],
    },
  },
  // keep: this handler must run before Nitro's built-in JSON wrapper, or HTTP bodies stop matching the WS error frames
  errorHandler: ["./server/lib/interrupt-error-handler.ts"],
  serverAssets: [
    {
      baseName: "builtin",
      dir: path.join(repoRoot, "apps/server/server/domains/packages/builtin"),
    },
  ],
  // keep: these CommonJS packages break when inlined into the ESM worker chunk (`__dirname`), and loro-crdt's WASM glue needs a `String.raw` path the tracer cannot follow, so they stay external
  traceDeps: [
    "heic-decode",
    "libheif-js",
    "bmp-ts",
    "@meridian-flow/mars-schema",
    "@meridian-flow/runtime",
    "loro-crdt*",
  ],
  features: {
    websocket: true,
  },
});
