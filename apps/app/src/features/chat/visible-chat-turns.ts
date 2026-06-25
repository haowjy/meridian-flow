/**
 * Filters turns to only those that should render in the chat column.
 *
 * System turns are model-plumbing (commit echoes, agent-swap seeds) —
 * they carry context for the model's next request but are not user-facing
 * prose. Compaction turns are internal bookkeeping. Both are hidden.
 *
 * System turns with `custom` blocks (helper results, component blocks)
 * ARE visible — they carry UI content the user should see.
 */
import type { Turn } from "@meridian/contracts/protocol";

export function isVisibleChatTurn(turn: Turn): boolean {
  if (turn.role === "user" || turn.role === "assistant") return true;
  if (turn.role === "compaction") return false;
  // system turns: visible only if they carry at least one custom block
  return turn.blocks.some((block) => block.blockType === "custom");
}

export function filterVisibleTurns(turns: Turn[]): Turn[] {
  return turns.filter(isVisibleChatTurn);
}
