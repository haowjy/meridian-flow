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
    // Node 25+'s global localStorage shadows jsdom's; disable it with --no-experimental-webstorage
    execArgv: ["--no-experimental-webstorage"],
  },
});
