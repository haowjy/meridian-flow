/** Canonical visible-conversational-head and action-required policy. */
import type { JsonValue, Turn, TurnRole } from "@meridian/contracts/threads";

export function isVisibleConversationalTurn(input: {
  role: TurnRole;
  metadata: JsonValue | null;
  hasCustomBlock: boolean;
}): boolean {
  if (input.role === "assistant") return true;
  if (input.role === "system") {
    const metadata = input.metadata as Record<string, unknown> | null;
    return metadata?.kind !== "subagent_update" && input.hasCustomBlock;
  }
  if (input.role !== "user") return false;
  const metadata = input.metadata as Record<string, unknown> | null;
  if (metadata?.kind === "inbox_message") return false;
  if (metadata?.kind !== "system_update") return true;
  return metadata.section !== "work_context";
}

export function isThreadActionRequired(input: {
  activeLineage: ReadonlyArray<Pick<Turn, "role" | "status">>;
}): boolean {
  const nearestAssistant = input.activeLineage.find((turn) => turn.role === "assistant");
  return nearestAssistant?.status === "waiting_interrupt";
}
