import type { Database } from "@meridian/database";
import {
  getDrizzleTransactionLocal,
  runInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "../../../shared/drizzle-transaction.js";
import { lockThreadAsRuntime } from "../../../shared/thread-work-lock.js";
import { isMultiThreadLocker, type ThreadLock } from "../loop/thread-lock.js";
import { noteThreadLocked, type RunStatePublisher } from "./drizzle-run-state.js";

export function createDrizzleThreadLock(
  db: Database,
  events: RunStatePublisher["events"] | null = null,
): ThreadLock {
  return {
    withThreadLock(threadId, operation) {
      return runInDrizzleTransaction(db, async () => {
        const later = noteThreadLock(threadId);
        await lockThreadAsRuntime(db, threadId, { skipLockedAsks: later });
        noteThreadLocked(threadId, events && { db, events });
        return operation();
      });
    },
  };
}

const lockedThreads = {};
const assertLockOrder = process.env.NODE_ENV !== "production";

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
