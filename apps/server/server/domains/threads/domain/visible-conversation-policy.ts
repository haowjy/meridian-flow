import type { JsonValue, Turn, TurnRole } from "@meridian/contracts/threads";
import {
  ChildCompletionMetadataTagCodec,
  InboxMessageMetadataCodec,
  SystemUpdateMetadataCodec,
} from "./turn-metadata.js";

export const MAX_LINEAGE_DEPTH = 10_000;

export function isVisibleConversationalTurn(input: {
  role: TurnRole;
  metadata: JsonValue | null;
  hasCustomBlock: boolean;
}): boolean {
  if (input.role === "assistant") return true;
  if (input.role === "system") {
    return (
      !ChildCompletionMetadataTagCodec.safeParse(input.metadata).success && input.hasCustomBlock
    );
  }
  if (input.role !== "user") return false;
  if (InboxMessageMetadataCodec.safeParse(input.metadata).success) return false;
  const systemUpdate = SystemUpdateMetadataCodec.safeParse(input.metadata);
  return !systemUpdate.success || systemUpdate.data.section !== "work_context";
}

export function findConversationalHead(
  leaf: Turn | undefined,
  parent: (turn: Turn) => Turn | undefined,
  hasCustomBlock: (turn: Turn) => boolean,
): Turn | undefined {
  for (
    let turn = leaf, depth = 0;
    turn && depth <= MAX_LINEAGE_DEPTH;
    turn = parent(turn), depth++
  ) {
    if (turn.forgottenBy) continue;
    if (
      isVisibleConversationalTurn({
        role: turn.role,
        metadata: turn.metadata ?? null,
        hasCustomBlock: hasCustomBlock(turn),
      })
    )
      return turn;
  }
  return undefined;
}

export function isThreadActionRequired(input: {
  activeLineage: ReadonlyArray<Pick<Turn, "role" | "status">>;
}): boolean {
  const nearestAssistant = input.activeLineage.find((turn) => turn.role === "assistant");
  return nearestAssistant?.status === "awaiting_answer";
}
