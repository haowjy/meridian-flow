/**
 * partition-turn-segments — structural Thinking/Activity segmentation for assistant turns.
 *
 * Purpose: Converts an already ordered `Block[]` into interrupt- and
 * card-bounded turn segments, then separates each segment into process-fold
 * runs and the visible activity frontier. Durable turn settlement is the only
 * lifecycle input: transient stream shape never changes the partition.
 */
import {
  type Block,
  blockContentRecord,
  blockPlainText,
  interruptIdForBlock,
} from "@meridian/contracts/protocol";
import {
  isChildReportBlock,
  isHelperResultBlock,
  isImageBlock,
  isToolDeliveryBlock,
} from "./block-kind";
import { groupDeliverySegments } from "./group-delivery-segments";
import { isToolViewVisible } from "./tool-view-visibility";

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
  return splitAtSegmentBoundaries(blocks)
    .map((segment) => partitionSegment(segment, settled))
    .filter((segment) => segment.foldRuns.length > 0 || segment.frontier.length > 0);
}

/**
 * ask_user, spawn, and return_result each close a segment with a custom card.
 * The tool protocol stays hidden; the card is the last block of the segment.
 */
function isSegmentBoundary(block: Block): boolean {
  return isInterruptBlock(block) || isHelperResultBlock(block) || isChildReportBlock(block);
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

  const hiddenCalls = hiddenToolCallIds(frontierRun.blocks);
  const foldedFrontierTools = frontierRun.blocks.filter((block) =>
    isFoldableToolBlock(block, hiddenCalls),
  );
  const visibleFrontier = frontierRun.blocks.filter(
    (block) => !isFoldableToolBlock(block, hiddenCalls),
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
 * Turn-card protocol (`ask_user`, `spawn`, `return_result`) never folds: its
 * card is the writer-facing surface, and the raw rows stay hidden on the
 * frontier. Images stay on the frontier too. Only process tools fold.
 */
function isFoldableToolBlock(block: Block, hiddenCalls: ReadonlySet<string>): boolean {
  if (!isToolDeliveryBlock(block) || isImageBlock(block)) return false;
  const toolCallId = blockContentRecord(block).toolCallId;
  return !(typeof toolCallId === "string" && hiddenCalls.has(toolCallId));
}

/**
 * toolCallIds whose tool rows a turn card hides, read through the same
 * visibility policy the render path uses. `tool_result` blocks carry
 * `toolName` only for `spawn`, so an unnamed result is matched to its
 * `tool_use` by pairing before classification.
 */
function hiddenToolCallIds(blocks: Block[]): Set<string> {
  const hidden = new Set<string>();
  for (const segment of groupDeliverySegments(blocks)) {
    const tools =
      segment.kind === "tool" ? [segment.tool] : segment.kind === "tool-run" ? segment.tools : [];
    for (const tool of tools) {
      if (!isToolViewVisible(tool) && tool.toolCallId) hidden.add(tool.toolCallId);
    }
  }
  return hidden;
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
