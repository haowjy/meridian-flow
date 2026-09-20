/**
 * Per-thread serialization for the inbox. `enqueue` and the run's final claim
 * take the same short lock so an insert cannot interleave with the final
 * empty-check; Postgres exposes it as a transaction-scoped advisory lock and
 * the in-memory adapter uses a promise-chain mutex. It is a latency mechanism,
 * not the durable guarantee — the wake sweep recovers a pending steer either way.
 */
import type { ThreadId } from "@meridian/contracts/runtime";

export interface ThreadLock {
  withThreadLock<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T>;
}

/** Distinct from the run-ownership lock seed (81); never share a seed across concerns. */
export const THREAD_LOCK_SEED = 82n;

export function threadLockKey(threadId: ThreadId): string {
  return `meridian:thread-lock:${threadId}`;
}
