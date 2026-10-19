/** Same-destination creation/replay is exclusive until post-commit preparation settles. */
import type { ThreadId } from "@meridian/contracts";

export interface DerivationLock {
  withDestination<T>(
    threadId: ThreadId,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}
