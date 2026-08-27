/** Canonical visible-conversational-head and action-required policy. */
import type { JsonValue, TurnRole, TurnStatus } from "@meridian/contracts/threads";

export function isVisibleConversationalTurn(input: {
  role: TurnRole;
  metadata: JsonValue | null;
  hasCustomBlock: boolean;
}): boolean {
  if (input.role === "assistant") return true;
  if (input.role === "system") return input.hasCustomBlock;
  if (input.role !== "user") return false;
  const metadata = input.metadata as Record<string, unknown> | null;
  return !(metadata?.kind === "system_update" && metadata.section === "work_context");
}

export function isThreadActionRequired(input: {
  headRole: TurnRole | null;
  headStatus: TurnStatus | null;
}): boolean {
  return input.headRole === "assistant" && input.headStatus === "waiting_interrupt";
}
