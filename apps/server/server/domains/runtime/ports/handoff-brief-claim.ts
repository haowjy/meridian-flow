/** Process-shared ownership of one durable handoff seed's brief attempt. */
import type { TurnId } from "@meridian/contracts/runtime";

export interface HandoffBriefClaimHandle {
  release(): Promise<void>;
  onLost(listener: () => void): () => void;
}

export interface HandoffBriefClaim {
  tryAcquire(seedTurnId: TurnId): Promise<HandoffBriefClaimHandle | null>;
}
