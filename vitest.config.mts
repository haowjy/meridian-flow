import { defineConfig } from "vitest/config";
import { sharedTest } from "./tools/ci/vitest-shared";

const includeDatabase = process.env.RUN_DB_TESTS === "1";

export default defineConfig({
  test: {
    ...sharedTest,
    reporters: [
      "default",
      "./tools/ci/test-budget-reporter.ts",
      ...(includeDatabase ? ["./tools/ci/db-test-reporter.ts"] : []),
    ],
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "apps/server/vitest.isolated.config.ts",
      "tools/dev/vitest.config.ts",
      "tools/mf/vitest.config.ts",
      ...(includeDatabase ? ["apps/server/vitest.db.config.ts"] : []),
    ],
  },
});
