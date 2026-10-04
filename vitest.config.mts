import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: "50%",
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "tools/dev/vitest.config.ts",
      "tools/deploy/vitest.config.ts",
      "tools/release/vitest.config.ts",
    ],
  },
});
