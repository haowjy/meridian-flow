/**
 * The run's exit: under the same per-thread lock `enqueue` takes, claim the
 * inbox once more. A pending batch means the run keeps going into the next
 * iteration; only an empty batch releases the lease, so a steer cannot slip
 * between the final check and the release (the lost-wakeup window).
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Inbox, Lease, RunAuthority } from "./ports.js";
import type { ThreadLock } from "./thread-lock.js";

export type CloseRunOutcome = "continue" | "released";

export async function closeRun(input: {
  threadLock: ThreadLock;
  inbox: Inbox;
  runAuthority: RunAuthority;
  threadId: ThreadId;
  /** Absent in direct orchestrator use (tests); the caller owns the lease then. */
  lease: Lease | null;
}): Promise<CloseRunOutcome> {
  return input.threadLock.withThreadLock(input.threadId, async () => {
    const pending = await input.inbox.claimPending(input.threadId);
    if (pending.length > 0) return "continue";
    if (input.lease) await input.runAuthority.release(input.lease);
    return "released";
  });
}
