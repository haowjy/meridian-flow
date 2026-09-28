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
