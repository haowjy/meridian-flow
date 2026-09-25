/** partition-turn — turns an ordered `Block[]` into the ordered render items the transcript draws. */
import { type Block, blockContentRecord, blockPlainText } from "@meridian/contracts/protocol";
import { isToolDeliveryBlock } from "./block-kind";
import { groupDeliverySegments } from "./group-delivery-segments";
import { isArtifactBlock } from "./tool-kind";
import { isToolViewVisible } from "./tool-view-visibility";

export type Run = { kind: "reasoning"; blocks: Block[] } | { kind: "activity"; blocks: Block[] };

export type RenderItem =
  | { kind: "process"; runs: Run[] }
  | { kind: "text"; block: Block }
  | { kind: "artifact"; block: Block };

export function isReasoningBlock(block: Block): boolean {
  return block.blockType === "reasoning" || block.blockType === "thinking";
}

export function partitionTurn(blocks: Block[]): RenderItem[] {
  const hidden = hiddenToolCallIds(blocks);
  const items: RenderItem[] = [];
  let runs: Run[] | null = null;

  const flushProcess = () => {
    if (runs && runs.length > 0) items.push({ kind: "process", runs });
    runs = null;
  };
  const pushProcessBlock = (runKind: Run["kind"], block: Block) => {
    if (!runs) runs = [];
    const last = runs[runs.length - 1];
    if (last && last.kind === runKind) last.blocks.push(block);
    else runs.push({ kind: runKind, blocks: [block] } as Run);
  };

  for (const block of blocks) {
    if (isToolDeliveryBlock(block)) {
      const toolCallId = blockContentRecord(block).toolCallId;
      if (typeof toolCallId === "string" && hidden.has(toolCallId)) continue;
      pushProcessBlock("activity", block);
      continue;
    }

    if (isReasoningBlock(block)) {
      if (hasVisibleReasoningText(block)) pushProcessBlock("reasoning", block);
      continue;
    }

    if (block.blockType === "text") {
      if (!block.textContent?.trim()) continue;
      flushProcess();
      items.push({ kind: "text", block });
      continue;
    }

    // AG-UI progress placeholders parked under a non-canonical blockType are
    // transport liveness, not deliverable content.
    if (block.blockType === ("activity" as Block["blockType"])) continue;

    if (isArtifactBlock(block)) {
      flushProcess();
      items.push({ kind: "artifact", block });
      continue;
    }

    // Unknown non-canonical block: keep it visible rather than folding it away.
    flushProcess();
    items.push({ kind: "artifact", block });
  }

  flushProcess();
  return items;
}

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

/**
 * Empty reasoning is a provider repair placeholder, not writer-facing thought.
 * Dropping it keeps a blank block from opening an empty Thinking fold.
 */
export function visibleReasoningText(block: Block): string | null {
  const text = block.textContent?.trim() || blockPlainText(block.blockType, block.content)?.trim();
  return text || null;
}

export function hasVisibleReasoningText(block: Block): boolean {
  return visibleReasoningText(block) !== null;
}
