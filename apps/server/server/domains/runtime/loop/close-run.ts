/**
 * The run's exit: under the same per-thread lock `enqueue` takes, claim the
 * inbox once more, then complete the terminal turn and release the lease. A
 * pending batch means the run keeps going into the next iteration and nothing
 * is released or completed; only an empty batch runs the caller's completion
 * and releases the lease. Holding the lock across both closes the lost-wakeup
 * window and—critically—the two-run window: a steer enqueued at any point
 * either is seen by this final claim or waits on the lock until the terminal
 * turn is durable and the lease is gone, so it can never start a second run
 * mid-terminal. The completion is bookkeeping only; keep it free of model
 * calls and tool execution.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Inbox, Lease, RunAuthority } from "./ports.js";
import type { ThreadLock } from "./thread-lock.js";

export type CloseRunOutcome<T> = { kind: "continue" } | { kind: "completed"; completion: T };

export async function closeRun<T>(input: {
  threadLock: ThreadLock;
  inbox: Inbox;
  runAuthority: RunAuthority;
  threadId: ThreadId;
  /** Absent in direct orchestrator use (tests); the caller owns the lease then. */
  lease: Lease | null;
  /** The terminal write; runs inside the lock, before the lease is released. */
  complete: () => Promise<T>;
}): Promise<CloseRunOutcome<T>> {
  return input.threadLock.withThreadLock(input.threadId, async () => {
    const pending = await input.inbox.claimPending(input.threadId);
    if (pending.length > 0) return { kind: "continue" };
    const completion = await input.complete();
    if (input.lease) await input.runAuthority.release(input.lease);
    return { kind: "completed", completion };
  });
}
