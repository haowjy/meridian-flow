/** Post-commit seam for starting the independent handoff brief service. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export interface HandoffBriefLauncher {
  launchAfterCommit(input: { threadId: ThreadId; seedTurnId: TurnId }): void;
}
