/**
 * Filters turns to only those that should render in the chat column.
 *
 * System turns are model-plumbing (commit echoes, agent-swap seeds); they carry
 * context for the model's next request but are not standalone chat bubbles.
 * Inbox delivery turns render inside the preceding assistant's activity rows.
 *
 * Other system turns with custom blocks remain visible as UI content.
 */
import type { Turn } from "@meridian/contracts/protocol";

export function isVisibleChatTurn(
  turn: Turn,
  queueStatusByTurnId?: ReadonlyMap<string, "queued" | "waiting">,
): boolean {
  if (turn.role === "user") {
    const metadata = turn.metadata;
    if (
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      metadata.kind === "system_update" &&
      metadata.section === "work_context"
    ) {
      return false;
    }
    if (
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      metadata.kind === "inbox_message"
    )
      return queueStatusByTurnId?.has(turn.id) ?? false;
    return true;
  }
  if (turn.role === "assistant") return true;
  if (turn.role === "compaction") return false;
  const metadata = turn.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.kind === "subagent_update"
  )
    return false;
  // other system turns are visible only if they carry at least one custom block
  return turn.blocks.some((block) => block.blockType === "custom");
}

export function filterVisibleTurns(
  turns: Turn[],
  queueStatusByTurnId?: ReadonlyMap<string, "queued" | "waiting">,
): Turn[] {
  return turns.filter((turn) => isVisibleChatTurn(turn, queueStatusByTurnId));
}
