import { defineConfig } from "vitest/config";

/**
 * Root config for opt-in database-facing suites.
 *
 * The default `pnpm test` stays deterministic and should not require a live
 * database. Use this config for suites that intentionally exercise Postgres:
 *
 *   RUN_DB_TESTS=1 DATABASE_URL=postgres://... pnpm exec vitest run -c vitest.db.config.mts
 */
export default defineConfig({
  test: {
    projects: ["packages/database/vitest.config.ts", "apps/server/vitest.config.ts"],
  },
});
