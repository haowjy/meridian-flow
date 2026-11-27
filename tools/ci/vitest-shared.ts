import { availableParallelism } from "node:os";

const includeDatabase = process.env.RUN_DB_TESTS === "1";
export const databaseWorkers = process.env.DB_TEST_DATABASE_URLS
  ? (JSON.parse(process.env.DB_TEST_DATABASE_URLS) as string[]).length || 1
  : 1;

const localWorkers = Math.max(
  1,
  Math.min(8, Number(process.env.TEST_MAX_WORKERS ?? Math.floor(availableParallelism() / 2))),
);

const maxWorkers = includeDatabase
  ? databaseWorkers
  : process.env.CI
    ? Math.min(8, availableParallelism())
    : localWorkers;

// Vitest 5 does not pass the root `test` options to project config files, and a config that forgets this spread makes Vitest refuse the run
export const sharedTest = {
  maxWorkers,
  pool: "threads",
  sequence: { shuffle: true },
} as const;
