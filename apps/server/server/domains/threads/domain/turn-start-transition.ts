/** Domain conflict raised when a thread cannot accept another turn transition. */

import type { ThreadId } from "@meridian/contracts/runtime";

export type TurnStartConflictReason = "already_exists" | "already_running";

export class TurnStartConflictError extends Error {
  constructor(
    readonly threadId: ThreadId,
    readonly reason: TurnStartConflictReason,
  ) {
    super(
      reason === "already_running"
        ? `Turn already running for thread: ${threadId}`
        : `Root turn already exists for thread: ${threadId}`,
    );
    this.name = "TurnStartConflictError";
  }
}
