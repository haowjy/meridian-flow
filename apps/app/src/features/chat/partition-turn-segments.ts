/**
 * partition-turn-segments — structural Thinking/Activity segmentation for assistant turns.
 *
 * Purpose: Converts an already ordered `Block[]` into interrupt- and
 * spawn-bounded turn segments, then separates each segment into process-fold
 * runs and the visible activity frontier. Durable turn settlement is the only
 * lifecycle input: transient stream shape never changes the partition.
 */
import { type Block, interruptIdForBlock } from "@meridian/contracts/protocol";
import { isImageBlock, isSpawnBlock, isToolDeliveryBlock } from "./block-kind";

export type Run = { kind: "reasoning"; blocks: Block[] } | { kind: "activity"; blocks: Block[] };

export type TurnSegment = {
  foldRuns: Run[];
  frontier: Block[];
};

export function isReasoningBlock(block: Block): boolean {
  return block.blockType === "reasoning" || block.blockType === "thinking";
}

export function isInterruptBlock(block: Block): boolean {
  return interruptIdForBlock(block) !== null;
}

export function partitionTurnSegments(blocks: Block[], settled: boolean): TurnSegment[] {
  return splitAtSegmentBoundaries(blocks).map((segment) => partitionSegment(segment, settled));
}

/**
 * A spawn tool_result is the same kind of writer-facing boundary as an
 * interrupt card: it closes the current Thinking/Activity pair so the spawn
 * stays visible and later reasoning starts a fresh fold. Split after the
 * result, not the tool_use, so pairing stays in one segment. An in-flight
 * spawn (use without result) stays on the live frontier of the current
 * segment — live turns do not fold tools.
 */
function isSegmentBoundary(block: Block): boolean {
  return isInterruptBlock(block) || (block.blockType === "tool_result" && isSpawnBlock(block));
}

function splitAtSegmentBoundaries(blocks: Block[]): Block[][] {
  const segments: Block[][] = [];
  let current: Block[] = [];

  for (const block of blocks) {
    current.push(block);
    if (isSegmentBoundary(block)) {
      segments.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function partitionSegment(blocks: Block[], settled: boolean): TurnSegment {
  const runs = groupRuns(blocks);
  const lastActivityRunIndex = findLastActivityRunIndex(runs);

  if (lastActivityRunIndex === -1) {
    return { foldRuns: runs, frontier: [] };
  }

  const frontierRun = runs[lastActivityRunIndex];
  if (!settled || !frontierRun) {
    return {
      foldRuns: runs.filter((_, index) => index !== lastActivityRunIndex),
      frontier: frontierRun?.blocks ?? [],
    };
  }

  const foldedFrontierTools = frontierRun.blocks.filter(isFoldableToolBlock);
  const visibleFrontier = frontierRun.blocks.filter((block) => !isFoldableToolBlock(block));
  const foldRuns = runs.flatMap((run, index): Run[] => {
    if (index !== lastActivityRunIndex) return [run];
    return foldedFrontierTools.length > 0
      ? [{ kind: "activity", blocks: foldedFrontierTools }]
      : [];
  });

  return { foldRuns, frontier: visibleFrontier };
}

// Tool rows fold on settlement except the ones that are themselves an
// affordance: images render a preview, and a spawn is the door to the child.
function isFoldableToolBlock(block: Block): boolean {
  return isToolDeliveryBlock(block) && !isImageBlock(block) && !isSpawnBlock(block);
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
