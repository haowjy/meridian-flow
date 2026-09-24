/**
 * The run's exit: under the same per-thread lock the producer `enqueue` takes
 * (`loop/threaded-inbox.ts`), claim the inbox once more, then complete the
 * terminal turn and release the lease. Holding the lock across both closes the
 * lost-wakeup window and—critically—the two-run window: a message enqueued at any
 * point either is seen by this final claim or waits on the lock until the
 * terminal turn is durable and the lease is gone, so it can never start a
 * second run mid-terminal. The completion is bookkeeping only; keep it free of
 * model calls and tool execution.
 *
 * `continueOnPending` is the exit policy, set by the caller:
 *   - `true` for normal completion (and the `end_turn`/steer exits). A pending
 *     batch means the run keeps going into the next iteration; nothing is
 *     completed or released, so a mid-run steer stays on the same turn.
 *   - `false` for cancel, hard error, budget cap, and max-iteration. The terminal
 *     completion runs and the lease releases even with a pending batch. For
 *     cancel that is the interrupt: the in-flight turn finalizes as `cancelled`,
 *     and the run owner starts the pending message as a distinct next turn. For
 *     the error exits the wake sweep (S4) recovers it.
 *
 * Release ownership: `closeRun` deletes the lease row in the same transaction
 * as `complete`; the physical session claim unlocks only after the outer
 * transaction commits. The run owner releases in its `finally` as the
 * cancel/error backstop (a generator throw bypasses this exit). That retry is
 * guarded against an already-released or superseded claim.
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
  /** See the header: `true` continues into a pending batch, `false` completes anyway. */
  continueOnPending: boolean;
  /** The terminal write; runs inside the lock, before the lease is released. */
  complete: () => Promise<T>;
  /** Optional current-state publication after releasing a bound lease, under the same lock. */
  afterRelease?: () => Promise<void>;
}): Promise<CloseRunOutcome<T>> {
  return input.threadLock.withThreadLock(input.threadId, async () => {
    const pending = await input.inbox.claimPending(input.threadId);
    if (input.continueOnPending && pending.length > 0) return { kind: "continue" };
    const completion = await input.complete();
    if (input.lease) await input.runAuthority.release(input.lease);
    if (input.lease) await input.afterRelease?.();
    return { kind: "completed", completion };
  });
}
