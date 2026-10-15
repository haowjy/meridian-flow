/** Materializes the one ordered retained tail shared by planning and projection. */

import type { Block, Turn } from "@meridian/contracts/threads";

export interface RetainedTurnSlice {
  turn: Turn;
  blocks: Block[];
}

export interface CompactionCut {
  turnId: string;
  blockSequence?: number;
}

/**
 * Finds where a complete compaction cut, among the turns the conversation still has. A compaction
 * can cut at (or pin) a writer message that a hand-back later took out of the chat; that turn is
 * not in `turns`. Its place is then read from the chain: the cut becomes the last turn before the
 * cut's successor (the first turn whose `prevTurnId` is the missing turn, else the compaction
 * itself), which is everything the cut covered. Null when no cut exists before the compaction.
 */
export function resolveCut(
  turns: readonly Turn[],
  compaction: Pick<Turn, "position">,
  compactedThrough: CompactionCut,
): CompactionCut | null {
  const own = turns.find((turn) => turn.id === compactedThrough.turnId);
  if (own) return own.position < compaction.position ? compactedThrough : null;
  const successor = turns
    .filter((turn) => turn.prevTurnId === compactedThrough.turnId)
    .reduce<Pick<Turn, "position">>(
      (first, turn) => (turn.position < first.position ? turn : first),
      compaction,
    );
  const before = turns.filter((turn) => turn.position < successor.position).at(-1);
  return before ? { turnId: before.id } : null;
}

export function retainedTail(input: {
  turns: readonly Turn[];
  blocksByTurn: ReadonlyMap<string, readonly Block[]>;
  cut: CompactionCut;
  pinnedRequests: readonly Turn[];
  canRetain: (turn: Turn) => boolean;
}): RetainedTurnSlice[] {
  const { turns, blocksByTurn, cut, pinnedRequests, canRetain } = input;
  const cutIndex = turns.findIndex((turn) => turn.id === cut.turnId);
  if (cutIndex < 0) throw new Error(`Compaction cut turn not found: ${cut.turnId}`);

  const pins = new Set(pinnedRequests.map((turn) => turn.id));
  const lifted = turns
    .slice(0, cutIndex + 1)
    .filter((turn) => pins.has(turn.id) && canRetain(turn));
  const liftedIds = new Set(lifted.map((turn) => turn.id));
  const result: RetainedTurnSlice[] = lifted.map((turn) => ({
    turn,
    blocks: [...(blocksByTurn.get(turn.id) ?? [])],
  }));

  for (let index = cutIndex; index < turns.length; index++) {
    const turn = turns[index];
    if (!turn || !canRetain(turn) || liftedIds.has(turn.id)) continue;
    if (index === cutIndex && cut.blockSequence === undefined) continue;

    const turnBlocks = [...(blocksByTurn.get(turn.id) ?? [])];
    const blockSequence = cut.blockSequence;
    const selectedBlocks =
      index === cutIndex && blockSequence !== undefined
        ? turnBlocks.filter((block) => block.sequence > blockSequence)
        : turnBlocks;
    if (turn.role !== "assistant" || selectedBlocks.length > 0) {
      result.push({ turn, blocks: selectedBlocks });
    }
  }

  return result;
}
