/** Runtime-facing operations that act on durable handoff seeds outside the run loop. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export interface HandoffBriefStopper {
  stop(threadId: ThreadId, seedTurnId: TurnId): Promise<boolean>;
}
