/** Cross-process ownership held for the full lifetime of a running thread turn. */
import type { ThreadId } from "@meridian/contracts/runtime";

export interface ThreadRunClaim {
  release(): Promise<void>;
}

export interface ThreadRunOwnership {
  /** Returns null when another server process currently owns the thread run. */
  tryAcquire(threadId: ThreadId): Promise<ThreadRunClaim | null>;
}

export function createInMemoryThreadRunOwnership(): ThreadRunOwnership {
  const owned = new Set<ThreadId>();
  return {
    async tryAcquire(threadId) {
      if (owned.has(threadId)) return null;
      owned.add(threadId);
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          owned.delete(threadId);
        },
      };
    },
  };
}
