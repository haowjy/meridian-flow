/**
 * partition-turn-segments — structural Thinking/Activity segmentation for assistant turns.
 *
 * Purpose: Converts an already ordered `Block[]` into checkpoint-bounded turn
 * segments, then separates each segment into process-fold runs and the visible
 * activity frontier. The key decision is that this module reads only block
 * order and block type/content shape, never streaming status, so live and
 * settled turns partition identically.
 */
import { type Block, checkpointIdForBlock } from "@meridian/contracts/protocol";

export type Run = { kind: "reasoning"; blocks: Block[] } | { kind: "activity"; blocks: Block[] };

export type TurnSegment = {
  foldRuns: Run[];
  frontier: Block[];
};

export function isReasoningBlock(block: Block): boolean {
  return block.blockType === "reasoning" || block.blockType === "thinking";
}

export function isCheckpointBlock(block: Block): boolean {
  return checkpointIdForBlock(block) !== null;
}

export function partitionTurnSegments(blocks: Block[]): TurnSegment[] {
  return splitAtCheckpoints(blocks).map(partitionSegment);
}

function splitAtCheckpoints(blocks: Block[]): Block[][] {
  const segments: Block[][] = [];
  let current: Block[] = [];

  for (const block of blocks) {
    current.push(block);
    if (isCheckpointBlock(block)) {
      segments.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function partitionSegment(blocks: Block[]): TurnSegment {
  const runs = groupRuns(blocks);
  const lastActivityRunIndex = findLastActivityRunIndex(runs);

  if (lastActivityRunIndex === -1) {
    return { foldRuns: runs, frontier: [] };
  }

  return {
    foldRuns: runs.filter((_, index) => index !== lastActivityRunIndex),
    frontier: runs[lastActivityRunIndex]?.blocks ?? [],
  };
}

function groupRuns(blocks: Block[]): Run[] {
  const runs: Run[] = [];

  for (const block of blocks) {
    const kind = isReasoningBlock(block) ? "reasoning" : "activity";
    const current = runs[runs.length - 1];

    if (current?.kind === kind) {
      current.blocks.push(block);
      continue;
    }

    runs.push({ kind, blocks: [block] } as Run);
  }

  return runs;
}

function findLastActivityRunIndex(runs: Run[]): number {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]?.kind === "activity") return index;
  }
  return -1;
}
