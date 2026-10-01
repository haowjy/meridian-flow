/** Canonical visible-conversational-head and action-required policy. */
import type { JsonValue, Turn, TurnRole } from "@meridian/contracts/threads";
import {
  ChildCompletionMetadataTagCodec,
  InboxMessageMetadataCodec,
  SystemUpdateMetadataCodec,
} from "./turn-metadata.js";

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

export function isThreadActionRequired(input: {
  activeLineage: ReadonlyArray<Pick<Turn, "role" | "status">>;
}): boolean {
  const nearestAssistant = input.activeLineage.find((turn) => turn.role === "assistant");
  return nearestAssistant?.status === "waiting_interrupt";
}
