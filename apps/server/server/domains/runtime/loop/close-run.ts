/** Final locked inbox boundary: split directed messages, or finalize and release. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Inbox, Lease, RunAuthority } from "./ports.js";
import type { ThreadLock } from "./thread-lock.js";

export type CloseRunOutcome<T> =
  | { kind: "split"; completion: T }
  | { kind: "completed"; completion: T };

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
  splitAndContinue?: (batch: import("./ports.js").InboxMessage[]) => Promise<T>;
  /** Optional current-state publication after releasing a bound lease, under the same lock. */
  afterRelease?: () => Promise<void>;
}): Promise<CloseRunOutcome<T>> {
  return input.threadLock.withThreadLock(input.threadId, async () => {
    const pending = await input.inbox.claimPending(input.threadId);
    if (input.continueOnPending && pending.some((message) => message.intent === "message")) {
      if (!input.splitAndContinue) throw new Error("Directed continuation requires a turn split");
      return { kind: "split", completion: await input.splitAndContinue(pending) };
    }
    const completion = await input.complete();
    if (input.lease) await input.runAuthority.release(input.lease);
    if (input.lease) await input.afterRelease?.();
    return { kind: "completed", completion };
  });
}
