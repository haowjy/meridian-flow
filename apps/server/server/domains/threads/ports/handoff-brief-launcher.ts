/** Claim handoff from derivation creation to the detached brief service. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export interface HandoffBriefHold {
  release(): Promise<void>;
  onLost(listener: () => void): () => void;
}

export interface HandoffBriefLauncher {
  hold(threadId: ThreadId): Promise<HandoffBriefHold | null>;
  launchAfterCommit(input: {
    threadId: ThreadId;
    seedTurnId: TurnId;
    claim: HandoffBriefHold;
  }): void;
}
