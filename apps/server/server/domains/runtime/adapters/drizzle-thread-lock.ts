/**
 * PostgreSQL adapter for the per-thread inbox lock. The transaction-scoped
 * advisory lock is held only for the short critical section (a claim or an
 * enqueue), never across a model call or a tool. The thread's own ask rows
 * lock first: every ask transition claims its row before a thread lock.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockThreadAsks, lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import { THREAD_LOCK_SEED, type ThreadLock, threadLockKey } from "../loop/thread-lock.js";
import { noteThreadLocked, type RunStatePublisher } from "./drizzle-run-state.js";

export function createDrizzleThreadLock(
  db: Database,
  events: RunStatePublisher["events"] | null = null,
): ThreadLock {
  return {
    withThreadLock(threadId, operation) {
      return runInDrizzleTransaction(db, async () => {
        await lockThreadAsks(db, [threadId]);
        await currentDrizzleDb(db).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${threadLockKey(threadId)}, ${THREAD_LOCK_SEED}))`,
        );
        await lockThreadForMutation(db, threadId);
        noteThreadLocked(threadId, events && { db, events });
        return operation();
      });
    },
  };
}
