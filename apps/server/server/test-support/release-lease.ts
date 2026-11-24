import type { Database } from "@meridian/database";
import { createDrizzleThreadLock } from "../domains/runtime/adapters/drizzle-thread-lock.js";
import type { Lease, RunClaim } from "../domains/runtime/loop/ports.js";
import { createQuietDrizzleJournalWriter } from "./journal-writer.js";

export function releaseLeaseUnderLock(
  db: Database,
  runClaim: Pick<RunClaim, "release">,
  lease: Lease,
) {
  return createDrizzleThreadLock(db, createQuietDrizzleJournalWriter(db)).withThreadLock(
    lease.threadId,
    () => runClaim.release(lease),
  );
}
