/**
 * The latest row: the turn Retry is allowed on, and the only turn a failed attempt can be forgotten from.
 * A closing row ends the previous reply's turn; every other turn (a write-mode switch, a Work-context
 * refresh, a notice, a skill body, a `subagent_update` delivery, a seed) trails it without closing it.
 * Retry's compare-and-swap and forgetting share this one walk, so the app never offers a Retry the server
 * refuses. It reads the graph because the turns it walks over may have left the conversation.
 */
import type { TurnId } from "@meridian/contracts/runtime";
import { isClosingRow, type Turn } from "@meridian/contracts/threads";
import { turnGraph } from "../../threads/ports/turn-graph.js";

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

/**
 * The first closing row that follows `turnId` on the chain ending at `leaf`: the boundary where that turn's
 * failure ends. Walking back from the leaf, the last closing row met before reaching the turn is the one
 * nearest it. Null when nothing closes after it. A turn off the chain (an orphan the leaf has left) has no
 * position to be first after, so the latest closing row stands in.
 */
export async function firstClosingRowAfter(
  turns: Parameters<typeof turnGraph>[0],
  leaf: TurnId | null,
  turnId: string,
): Promise<Turn | null> {
  const graph = turnGraph(turns);
  const seen = new Set<string>();
  let latest: Turn | null = null;
  let nearest: Turn | null = null;
  let current = leaf ? await graph.findById(leaf) : null;
  while (current && !seen.has(current.id)) {
    if (current.id === turnId) return nearest;
    seen.add(current.id);
    if (isClosingRow(current)) {
      latest ??= current;
      nearest = current;
    }
    current = current.prevTurnId ? await graph.findById(current.prevTurnId as TurnId) : null;
  }
  return latest;
}
