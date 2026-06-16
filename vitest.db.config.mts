import { defineConfig } from "vitest/config";
import { assertThrowawayDatabaseForRunDbTests } from "./packages/database/src/__test-support__/db-fixtures.ts";

/**
 * Root config for opt-in database-facing suites.
 *
 * The default `pnpm test` stays deterministic and should not require a live
 * database. Use this config for suites that intentionally exercise Postgres:
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://... pnpm exec vitest run -c vitest.db.config.mts
 */
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (RUN_DB_TESTS && !DATABASE_URL) {
  throw new Error(
    "RUN_DB_TESTS requires DATABASE_URL to point at a dedicated throwaway Postgres DB.",
  );
}

if (RUN_DB_TESTS && DATABASE_URL) {
  assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
}

export default defineConfig({
  test: {
    projects: ["packages/database/vitest.config.ts", "apps/server/vitest.db.config.ts"],
  },
});
