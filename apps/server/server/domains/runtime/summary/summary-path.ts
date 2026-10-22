/** Chooses the one summary request shape from facts known before the call. */

import type { Turn } from "@meridian/contracts/threads";
import {
  CompactionMetadataCodec,
  HandoffSeedMetadataCodec,
} from "../../threads/domain/turn-metadata.js";

export function chooseSummaryPath(input: {
  knownTooLarge: boolean;
  hasRequestInHand: boolean;
  cacheState: "warm" | "cold";
}): "branch" | "rolling" {
  if (input.knownTooLarge) return "rolling";
  return input.hasRequestInHand && input.cacheState === "warm" ? "branch" : "rolling";
}

/** Whether the latest settled summary attempt of this owner kind was rejected as too large. */
export function previousAttemptRejectedAsTooLarge(
  turns: readonly Turn[],
  currentTurnId: string,
  ownerKind: "compaction" | "handoff_seed",
): boolean {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const current = byId.get(currentTurnId);
  // The chain is the graph. A link that left the conversation (a handed-back message) is not in
  // `turns`, so the walk steps over it to the last turn before the one that pointed at it.
  const stepBack = (child: Turn, parentId: string | null | undefined): Turn | undefined =>
    parentId == null
      ? undefined
      : (byId.get(parentId) ??
        turns
          .filter((turn) => turn.position < child.position)
          .reduce<Turn | undefined>(
            (latest, turn) => (!latest || turn.position > latest.position ? turn : latest),
            undefined,
          ));
  let turn = current ? stepBack(current, current.prevTurnId) : undefined;
  while (turn) {
    if (turn.status !== "pending") {
      if (ownerKind === "compaction" && turn.role === "compaction")
        return (
          CompactionMetadataCodec.safeParse(turn.metadata).data?.reason === "request_too_large"
        );
      if (ownerKind === "handoff_seed" && turn.role === "system") {
        const metadata = HandoffSeedMetadataCodec.safeParse(turn.metadata);
        if (metadata.success) return metadata.data.reason === "request_too_large";
      }
    }
    turn = stepBack(turn, turn.prevTurnId);
  }
  return false;
}
