import { defineConfig } from "vitest/config";

const includeDatabase = process.env.RUN_DB_TESTS === "1";
const databaseWorkers = process.env.DB_TEST_DATABASE_URLS
  ? (JSON.parse(process.env.DB_TEST_DATABASE_URLS) as string[]).length
  : 1;

export default defineConfig({
  test: {
    // Mixed projects share a worker budget; it must match the capped DB fleet.
    maxWorkers: includeDatabase ? databaseWorkers : "50%",
    pool: "threads",
    reporters: includeDatabase ? ["default", "./tools/ci/db-test-reporter.ts"] : ["default"],
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "tools/dev/vitest.config.ts",
      ...(includeDatabase ? ["apps/server/vitest.db.config.ts"] : []),
    ],
  },
});
