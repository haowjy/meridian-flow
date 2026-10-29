/**
 * Per-thread serialization for the inbox. `enqueue` and the run's final claim
 * take the same short lock so an insert cannot interleave with the final
 * empty-check; Postgres exposes it as a transaction-scoped advisory lock and
 * the in-memory adapter uses a promise-chain mutex. It is a latency mechanism,
 * not the durable guarantee — the wake sweep recovers a pending message either way.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadId } from "@meridian/contracts/runtime";

export interface ThreadLock {
  withThreadLock<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T>;
}

/** Distinct from the run-ownership lock seed (81); never share a seed across concerns. */
export const THREAD_LOCK_SEED = 82n;

export function threadLockKey(threadId: ThreadId): string {
  return `meridian:thread-lock:${threadId}`;
}

const multiThreadLocker = new AsyncLocalStorage<true>();

/**
 * Runs the one command allowed to hold several thread locks in a transaction: lineage
 * cancellation, which locks its owner, then each target parents first. A thread lock takes that
 * thread's held ask rows first; after the transaction's first thread lock the Postgres adapter
 * skips ask rows another transaction holds rather than wait on them, so no ask row lock waits
 * behind a thread lock. Outside production it asserts that nothing else takes a second thread's
 * lock.
 */
export function asMultiThreadLocker<T>(operation: () => Promise<T>): Promise<T> {
  return multiThreadLocker.run(true, operation);
}

export function isMultiThreadLocker(): boolean {
  return multiThreadLocker.getStore() === true;
}
