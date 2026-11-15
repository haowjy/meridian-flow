import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "nitro/config";
import { resolveReleaseId } from "../../tools/release/release-id.mjs";

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
  replace: {
    __MERIDIAN_RELEASE__: JSON.stringify(
      resolveReleaseId({ dev: process.env.NODE_ENV === "development" }),
    ),
  },
  experimental: { asyncContext: true },
  rolldownConfig: {
    plugins: [bundleWorkerEntries],
    output: {
      // Rolldown puts its helpers (`__exportAll`, `__toESM`) in a chunk shared by the same entries
      // as the app code; here that chunk also held html-markdown.ts, which imports the unified
      // libs, which import the helpers back. Node ran the libs first and died at import with
      // "__exportAll is not a function". A chunk that holds the helpers must import no lib, so
      // anything shared between entries that imports libs gets a chunk of its own. A new cycle of
      // this kind fails `pnpm smoke:prod-boot`.
      codeSplitting: { groups: [{ test: /html-markdown\.ts$/, name: "html-markdown" }] },
    },
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
  // the ESM worker chunk (the mars-schema WASM loader too), so they stay external and are traced into the output.
  traceDeps: ["heic-decode", "libheif-js", "bmp-ts", "@meridian-flow/mars-schema"],
  features: {
    websocket: true,
  },
});
