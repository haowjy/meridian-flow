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

/**
 * Runs `task` under the thread's run claim, or returns false when another owner
 * holds it. Delivery cardinality depends on this being the only claim path: the
 * task must finish before the claim is released so a racing writer or a second
 * process cannot interleave.
 */
export async function withRunClaim(
  ownership: ThreadRunOwnership,
  threadId: ThreadId,
  task: () => Promise<void>,
): Promise<boolean> {
  const claim = await ownership.tryAcquire(threadId);
  if (!claim) return false;
  try {
    await task();
    return true;
  } finally {
    await claim.release();
  }
}
