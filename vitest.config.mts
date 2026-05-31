import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "apps/api/vitest.config.ts",
      "apps/app/vitest.config.ts",
      "tools/dev/vitest.config.ts",
    ],
  },
});
