/** Canonical visible-conversational-head and action-required policy. */
import type { JsonValue, TurnRole, TurnStatus } from "@meridian/contracts/threads";
import {
  ChildCompletionMetadataCodec,
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
    return !ChildCompletionMetadataCodec.safeParse(input.metadata).success && input.hasCustomBlock;
  }
  if (input.role !== "user") return false;
  if (InboxMessageMetadataCodec.safeParse(input.metadata).success) return false;
  const systemUpdate = SystemUpdateMetadataCodec.safeParse(input.metadata);
  return !systemUpdate.success || systemUpdate.data.section !== "work_context";
}

export function isThreadActionRequired(input: {
  headRole: TurnRole | null;
  headStatus: TurnStatus | null;
}): boolean {
  return input.headRole === "assistant" && input.headStatus === "waiting_interrupt";
}
