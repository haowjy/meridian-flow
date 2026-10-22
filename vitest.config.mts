import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

const includeDatabase = process.env.RUN_DB_TESTS === "1";
const databaseWorkers = process.env.DB_TEST_DATABASE_URLS
  ? (JSON.parse(process.env.DB_TEST_DATABASE_URLS) as string[]).length
  : 1;

// Half the cores, but never more than 8. Measured on a 24-core shared host with
// the identical 2,414 cases: 4 workers 90s/2.4GB, 8 workers 59s/3.1GB, 12
// workers 53s/4.0GB, 16 workers 54s/5.2GB, 24 workers 85s/6.7GB plus a
// contention timeout. Peak memory is base + ~213MB per worker, so it tracks the
// worker count and not the file count: apps/app alone (208 files) peaks at
// 3.8GB, the same as all 449 files at 4.0GB. 8 is the last worker before wall
// time stops improving and memory keeps climbing. Override with TEST_MAX_WORKERS.
const localWorkers = Math.max(
  1,
  Math.min(8, Number(process.env.TEST_MAX_WORKERS ?? Math.floor(availableParallelism() / 2))),
);

export default defineConfig({
  test: {
    // Mixed projects share a worker budget; it must match the capped DB fleet.
    // CI runners are 4 cores and the 50% cap left each shard on 2 workers, which
    // is what made import-bound shards take ~95s, so CI takes all of them. Both
    // branches are numeric rather than a percentage: on a many-core runner a
    // percentage would walk itself into the 24-worker cliff, and the resulting
    // blast in memory would fail the memory ceiling instead of the run it was
    // there to measure.
    maxWorkers: includeDatabase
      ? databaseWorkers
      : process.env.CI
        ? Math.min(8, availableParallelism())
        : localWorkers,
    pool: "threads",
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
