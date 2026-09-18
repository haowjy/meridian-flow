/**
 * partition-turn-segments — structural Thinking/Activity segmentation for assistant turns.
 *
 * Purpose: Converts an already ordered `Block[]` into interrupt- and
 * spawn-bounded turn segments, then separates each segment into process-fold
 * runs and the visible activity frontier. Durable turn settlement is the only
 * lifecycle input: transient stream shape never changes the partition.
 */
import { type Block, blockPlainText, interruptIdForBlock } from "@meridian/contracts/protocol";
import {
  isChildReportBlock,
  isHelperResultBlock,
  isImageBlock,
  isSpawnToolBlock,
  isToolDeliveryBlock,
} from "./block-kind";

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
  // New turns hide the spawn protocol behind a helper-result card; old turns
  // have only the tool blocks, so they keep their card on the frontier.
  const turnHasHelperResult = blocks.some(isHelperResultBlock);
  return splitAtSegmentBoundaries(blocks, turnHasHelperResult)
    .map((segment) => partitionSegment(segment, settled, turnHasHelperResult))
    .filter((segment) => segment.foldRuns.length > 0 || segment.frontier.length > 0);
}

/**
 * ask_user, spawn, and return_result each close a segment with a custom card.
 * The tool protocol stays hidden; the card is the last block of the segment.
 * Old turns with no helper-result also split at the spawn tool_result so the
 * legacy card lands on its own segment frontier.
 */
function isSegmentBoundary(block: Block, turnHasHelperResult: boolean): boolean {
  if (isInterruptBlock(block) || isHelperResultBlock(block) || isChildReportBlock(block)) {
    return true;
  }
  return !turnHasHelperResult && block.blockType === "tool_result" && isSpawnToolBlock(block);
}

function splitAtSegmentBoundaries(blocks: Block[], turnHasHelperResult: boolean): Block[][] {
  const segments: Block[][] = [];
  let current: Block[] = [];

  for (const block of blocks) {
    current.push(block);
    if (isSegmentBoundary(block, turnHasHelperResult)) {
      segments.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function partitionSegment(
  blocks: Block[],
  settled: boolean,
  turnHasHelperResult: boolean,
): TurnSegment {
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

  const foldedFrontierTools = frontierRun.blocks.filter((block) =>
    isFoldableToolBlock(block, turnHasHelperResult),
  );
  const visibleFrontier = frontierRun.blocks.filter(
    (block) => !isFoldableToolBlock(block, turnHasHelperResult),
  );
  const foldRuns = runs.flatMap((run, index): Run[] => {
    if (index !== lastActivityRunIndex) return [run];
    return foldedFrontierTools.length > 0
      ? [{ kind: "activity", blocks: foldedFrontierTools }]
      : [];
  });

  return { foldRuns, frontier: visibleFrontier };
}

/**
 * A spawn's tool protocol is the writer's card only when no helper-result card
 * exists in the turn; otherwise the card replaced it and the protocol folds.
 */
function isFoldableToolBlock(block: Block, turnHasHelperResult: boolean): boolean {
  if (!isToolDeliveryBlock(block) || isImageBlock(block)) return false;
  if (isSpawnToolBlock(block) && !turnHasHelperResult) return false;
  return true;
}

function groupRuns(blocks: Block[]): Run[] {
  const runs: Run[] = [];

  for (const block of blocks) {
    if (isReasoningBlock(block) && !hasVisibleReasoningText(block)) continue;

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

/**
 * Empty reasoning is a provider repair placeholder, not writer-facing thought.
 * Dropping it here keeps a blank block from opening an empty Thinking fold or
 * splitting the activity runs on either side of it.
 */
function hasVisibleReasoningText(block: Block): boolean {
  const text = block.textContent?.trim() || blockPlainText(block.blockType, block.content)?.trim();
  return Boolean(text);
}

function findLastActivityRunIndex(runs: Run[]): number {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]?.kind === "activity") return index;
  }
  return -1;
}
