/**
 * PostgreSQL adapter for the per-thread inbox lock. The transaction-scoped
 * advisory lock is held only for the short critical section (a claim or an
 * enqueue), never across a model call or a tool.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { THREAD_LOCK_SEED, type ThreadLock, threadLockKey } from "../loop/thread-lock.js";

export function createDrizzleThreadLock(db: Database): ThreadLock {
  return {
    withThreadLock(threadId, operation) {
      return runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${threadLockKey(threadId)}, ${THREAD_LOCK_SEED}))`,
        );
        return operation();
      });
    },
  };
}
