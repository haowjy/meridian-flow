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
    async startExecution(threadId, executionId, settle) {
      const lease = await claim.startExecution(threadId, executionId, settle);
      if (!lease) turnedAway(threadId);
      return lease;
    },
  };
}
