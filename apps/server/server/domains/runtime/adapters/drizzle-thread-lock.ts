/**
 * PostgreSQL adapter for the per-thread inbox lock. The transaction-scoped
 * advisory lock is held only for the short critical section (a claim or an
 * enqueue), never across a model call or a tool. The thread's own held ask rows
 * lock first, so no ask transition under the lock waits on an ask row. A
 * transaction that already holds a thread lock skips ask rows someone else holds
 * instead of waiting: that holder may be waiting on the lock it holds.
 * Outside production it asserts that only lineage cancellation takes a second
 * thread's lock.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  getDrizzleTransactionLocal,
  runInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "../../../shared/drizzle-transaction.js";
import { lockThreadAsks, lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import {
  isMultiThreadLocker,
  THREAD_LOCK_SEED,
  type ThreadLock,
  threadLockKey,
} from "../loop/thread-lock.js";
import { noteThreadLocked, type RunStatePublisher } from "./drizzle-run-state.js";

export function createDrizzleThreadLock(
  db: Database,
  events: RunStatePublisher["events"] | null = null,
): ThreadLock {
  return {
    withThreadLock(threadId, operation) {
      return runInDrizzleTransaction(db, async () => {
        const later = noteThreadLock(threadId);
        await lockThreadAsks(db, [threadId], { skipLocked: later });
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

const lockedThreads = {};
const assertLockOrder = process.env.NODE_ENV !== "production";

/**
 * Records this transaction's thread lock; true when it already holds one. A reentrant lock of the
 * same thread counts: a row someone asked for since the first lock is held by a transaction that
 * may be waiting on that lock.
 */
function noteThreadLock(threadId: string): boolean {
  let locked = getDrizzleTransactionLocal<Set<string>>(lockedThreads);
  if (!locked) {
    locked = new Set();
    setDrizzleTransactionLocal(lockedThreads, locked);
  }
  const later = locked.size > 0;
  if (assertLockOrder && later && !locked.has(threadId) && !isMultiThreadLocker())
    throw new Error(
      `Thread lock ${threadId} taken while holding ${[...locked].join(", ")}: only lineage cancellation may lock several threads`,
    );
  locked.add(threadId);
  return later;
}
