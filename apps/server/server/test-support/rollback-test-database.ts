/** Per-test PostgreSQL transactions that always roll back after Vitest finishes the case. */
import { createDb, type Database } from "@meridian/database";
import { TransactionRollbackError } from "drizzle-orm";
import { afterAll, aroundEach, beforeAll } from "vitest";

export interface RollbackTestDatabase {
  readonly current: Database;
}

/**
 * Register transaction isolation for the current suite.
 *
 * Read `current` inside `beforeEach` or the test body. It points at the active
 * transaction while the case runs and at the root connection outside a case.
 */
export function useRollbackTestDatabase(
  databaseUrl: string,
  options?: { max?: number; prepareSuite?: (db: Database) => Promise<void> },
): RollbackTestDatabase {
  const root = createDb(databaseUrl, options);
  let current = root;

  if (options?.prepareSuite) {
    beforeAll(() => options.prepareSuite?.(root));
  }

  aroundEach(async (runTest) => {
    try {
      await root.transaction(async (transaction) => {
        current = transaction as unknown as Database;
        await runTest();
        transaction.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    } finally {
      current = root;
    }
  });

  afterAll(async () => {
    await root.close();
  });

  return {
    get current() {
      return current;
    },
  };
}
