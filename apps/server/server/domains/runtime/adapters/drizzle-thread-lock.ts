/**
 * PostgreSQL adapter for the per-thread inbox lock. The transaction-scoped
 * advisory lock is held only for the short critical section (a claim or an
 * enqueue), never across a model call or a tool. The thread's own ask rows
 * lock first: every ask transition claims its row before a thread lock. Outside
 * production it asserts that only lineage cancellation takes a second thread's lock.
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
        assertOneThreadLock(threadId);
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

const lockedThreads = {};
const assertLockOrder = process.env.NODE_ENV !== "production";

/** A second thread's lock in one transaction would take its ask rows after a thread lock. */
function assertOneThreadLock(threadId: string) {
  if (!assertLockOrder) return;
  let locked = getDrizzleTransactionLocal<Set<string>>(lockedThreads);
  if (!locked) {
    locked = new Set();
    setDrizzleTransactionLocal(lockedThreads, locked);
  }
  if (locked.size > 0 && !locked.has(threadId) && !isMultiThreadLocker())
    throw new Error(
      `Thread lock ${threadId} taken while holding ${[...locked].join(", ")}: only lineage cancellation may lock several threads`,
    );
  locked.add(threadId);
}
