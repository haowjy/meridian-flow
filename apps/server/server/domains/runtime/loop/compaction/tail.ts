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
  pinnedRequest: Turn | null;
  canRetain: (turn: Turn) => boolean;
}): RetainedTurnSlice[] {
  const { turns, blocksByTurn, cut, pinnedRequest, canRetain } = input;
  const cutIndex = turns.findIndex((turn) => turn.id === cut.turnId);
  if (cutIndex < 0) throw new Error(`Compaction cut turn not found: ${cut.turnId}`);

  const pinnedIndex = pinnedRequest ? turns.findIndex((turn) => turn.id === pinnedRequest.id) : -1;
  const pinnedMustMove = pinnedRequest !== null && pinnedIndex >= 0 && pinnedIndex <= cutIndex;
  const result: RetainedTurnSlice[] = [];
  if (pinnedMustMove && canRetain(pinnedRequest)) {
    result.push({
      turn: pinnedRequest,
      blocks: (blocksByTurn.get(pinnedRequest.id) ?? []).filter((block) => !block.pruned),
    });
  }

  for (let index = cutIndex; index < turns.length; index++) {
    const turn = turns[index];
    if (!turn || !canRetain(turn) || turn.id === (pinnedMustMove ? pinnedRequest?.id : null))
      continue;
    if (index === cutIndex && cut.blockSequence === undefined) continue;

    const turnBlocks = (blocksByTurn.get(turn.id) ?? []).filter((block) => !block.pruned);
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
