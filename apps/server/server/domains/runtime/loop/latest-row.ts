/**
 * The latest row: the turn Retry is allowed on, and the only turn a failed attempt can be forgotten from.
 * A closing row ends the previous reply's turn; every other turn (a write-mode switch, a Work-context
 * refresh, a notice, a skill body, a `subagent_update` delivery, a seed) trails it without closing it.
 * Retry's compare-and-swap and forgetting share this one walk, so the app never offers a Retry the server
 * refuses. It reads the graph because the turns it walks over may have left the conversation.
 */
import type { TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import { isConversationTurn } from "../../threads/index.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";

/** A turn that ends the previous reply's turn as the latest row: a conversation turn or a compaction. */
export function isClosingRow(turn: Pick<Turn, "role" | "origin" | "metadata">): boolean {
  return turn.role === "compaction" || isConversationTurn(turn);
}

/** The closing row reached by walking back from `leaf`, and the non-closing turns walked over (leaf first). */
export async function latestRowAt(
  turns: Parameters<typeof turnGraph>[0],
  leaf: TurnId | null,
): Promise<{ latest: Turn | null; walkedOver: Turn[] }> {
  const graph = turnGraph(turns);
  const walkedOver: Turn[] = [];
  const seen = new Set<string>();
  let current = leaf ? await graph.findById(leaf) : null;
  while (current && !seen.has(current.id)) {
    if (isClosingRow(current)) return { latest: current, walkedOver };
    seen.add(current.id);
    walkedOver.push(current);
    current = current.prevTurnId ? await graph.findById(current.prevTurnId as TurnId) : null;
  }
  return { latest: null, walkedOver };
}
