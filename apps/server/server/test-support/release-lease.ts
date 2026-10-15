/**
 * Releases a run lease the way production does: under the chat's thread lock, so the row's deletion
 * publishes the chat's run-state record. Tests that simulate a finished or crashed run call this
 * instead of `runClaim.release` directly.
 */
import type { Database } from "@meridian/database";
import { createDrizzleThreadLock } from "../domains/runtime/adapters/drizzle-thread-lock.js";
import type { Lease, RunClaim } from "../domains/runtime/loop/ports.js";
import { createDrizzleEventJournalWriter } from "../domains/threads/adapters/drizzle/event-writer.js";

export function releaseLeaseUnderLock(
  db: Database,
  runClaim: Pick<RunClaim, "release">,
  lease: Lease,
) {
  return createDrizzleThreadLock(db, createDrizzleEventJournalWriter(db)).withThreadLock(
    lease.threadId,
    () => runClaim.release(lease),
  );
}
