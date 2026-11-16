import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedTest } from "../../tools/ci/vitest-shared";

export default defineConfig({
  define: { __MERIDIAN_RELEASE__: JSON.stringify("test") },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    ...sharedTest,
    exclude: ["e2e/**", "node_modules/**"],
    setupFiles: ["./vitest.setup.ts"],
    // Node 25+ defines a global localStorage that is undefined without --localstorage-file,
    // and it shadows jsdom's.
    execArgv: ["--no-experimental-webstorage"],
  },
});
