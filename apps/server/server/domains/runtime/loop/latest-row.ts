import type { TurnId } from "@meridian/contracts/runtime";
import { isClosingRow, type Turn } from "@meridian/contracts/threads";
import { turnGraph } from "../../threads/ports/turn-graph.js";

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
