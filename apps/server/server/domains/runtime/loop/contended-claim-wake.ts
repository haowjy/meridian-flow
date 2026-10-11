/**
 * Wraps the run claim so a short claim (`hold`, `withExclusiveThread`) that
 * turned another claim attempt away wakes its chat on release. The turned-away
 * attempt (a wake, an idle switch's apply) found the chat busy and gave up;
 * a reply's lease already wakes on release, but a short claim did not, so the
 * work it blocked waited for the sweep.
 *
 * Contention is process-local: an attempt turned away by another process's
 * claim still falls to the sweep.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { RunClaim } from "./ports.js";

export function wakeOnContendedRelease(
  claim: RunClaim,
  wake: (threadId: ThreadId) => void,
): RunClaim {
  const held = new Map<ThreadId, { contended: boolean }>();
  const turnedAway = (threadId: ThreadId) => {
    const entry = held.get(threadId);
    if (entry) entry.contended = true;
  };
  // Runs after the underlying release, so a wake never meets this claim.
  const released = (threadId: ThreadId, entry: { contended: boolean }) => {
    if (held.get(threadId) === entry) held.delete(threadId);
    if (entry.contended) wake(threadId);
  };

  return {
    ...claim,
    async hold(threadId) {
      const claimed = await claim.hold(threadId);
      if (!claimed) {
        turnedAway(threadId);
        return null;
      }
      const entry = { contended: false };
      held.set(threadId, entry);
      return {
        async release() {
          await claimed.release();
          released(threadId, entry);
        },
        onLost: (listener) => claimed.onLost(listener),
      };
    },
    async withExclusiveThread(threadId, operation) {
      let entry: { contended: boolean } | undefined;
      try {
        const result = await claim.withExclusiveThread(threadId, () => {
          entry = { contended: false };
          held.set(threadId, entry);
          return operation();
        });
        if (!entry) turnedAway(threadId);
        return result;
      } finally {
        if (entry) released(threadId, entry);
      }
    },
    async startExecution(threadId, runId) {
      const lease = await claim.startExecution(threadId, runId);
      if (!lease) turnedAway(threadId);
      return lease;
    },
  };
}
