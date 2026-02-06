import type { ToolBlockContent, TurnBlock } from "@/features/threads/types";
import { normalizeToolCallId } from "@/features/threads/utils/normalizeToolCallId";

/**
 * A tool interaction represents a paired tool_use and tool_result block.
 */
export interface ToolInteraction {
  toolUse: TurnBlock | null;
  toolResult: TurnBlock | null;
}

export type AssistantRenderItem =
  | { kind: "block"; block: TurnBlock }
  | {
      kind: "toolInteraction";
      toolUse: TurnBlock | null;
      toolResult: TurnBlock | null;
    }
  | {
      kind: "thinkingGroup";
      groupId: string;
      items: Array<
        | { kind: "thinking"; block: TurnBlock }
        | { kind: "tool"; interaction: ToolInteraction }
      >;
    }
  | { kind: "toolGroup"; groupId: string; items: ToolInteraction[] };

/**
 * Extract toolUseId from a block, normalized for consistent comparison.
 */
function getToolUseId(block: TurnBlock): string | null {
  if (!block.content) return null;
  const value = (block.content as ToolBlockContent).toolUseId;
  return typeof value === "string" ? normalizeToolCallId(value) : null;
}

/**
 * Groups tool_use + tool_result blocks with matching tool_use_id into a single
 * render item while leaving all other blocks untouched.
 *
 * Uses a two-pass algorithm to handle blocks arriving in any order
 * (result may arrive before use in streaming scenarios).
 *
 * This is a view-level grouping only – it does not mutate underlying data.
 */
export function buildAssistantRenderItems(
  blocks: TurnBlock[],
): AssistantRenderItem[] {
  const items: AssistantRenderItem[] = [];
  const consumedResultIndices = new Set<number>();

  // SOLID O: Pre-build lookup map for O(1) access regardless of order.
  // This allows matching tool_result to tool_use even if result arrives first.
  const toolResultIdToIndex = new Map<string, number>();

  // First pass: build result lookup map
  blocks.forEach((block, index) => {
    if (!block) return;
    if (block.blockType !== "tool_result") return;
    const id = getToolUseId(block);
    if (!id) return;
    // Only store the first result for each id (in case of duplicates)
    if (!toolResultIdToIndex.has(id)) {
      toolResultIdToIndex.set(id, index);
    }
  });

  // Second pass: group items
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;

    if (block.blockType === "tool_use") {
      const toolUseId = getToolUseId(block);
      if (!toolUseId) {
        items.push({ kind: "block", block });
        continue;
      }

      // Find matching result (may be before OR after in array)
      const resultIndex = toolResultIdToIndex.get(toolUseId);
      let matchedResult: TurnBlock | null = null;
      if (
        resultIndex !== undefined &&
        !consumedResultIndices.has(resultIndex)
      ) {
        matchedResult = blocks[resultIndex] ?? null;
        consumedResultIndices.add(resultIndex);
      }

      items.push({
        kind: "toolInteraction",
        toolUse: block,
        toolResult: matchedResult,
      });
      continue;
    }

    if (block.blockType === "tool_result") {
      if (consumedResultIndices.has(i)) {
        // Already paired with a tool_use
        continue;
      }

      // Result without a visible tool_use: render as a standalone interaction
      items.push({
        kind: "toolInteraction",
        toolUse: null,
        toolResult: block,
      });
      continue;
    }

    items.push({ kind: "block", block });
  }

  return items;
}

/**
 * Groups consecutive thinking blocks and tool interactions into a single
 * collapsible "thinking group" for cleaner UI presentation.
 *
 * Pattern recognized: thinking → tool → thinking → tool → ...
 * Groups break when a non-thinking/non-tool item (e.g., text block) appears.
 *
 * This is a second pass over the already-grouped render items.
 */
export function groupThinkingAndTools(
  items: AssistantRenderItem[],
  turnId: string,
): AssistantRenderItem[] {
  const result: AssistantRenderItem[] = [];

  // Items that can be part of a thinking group
  type ThinkingGroupItem =
    | { kind: "thinking"; block: TurnBlock }
    | { kind: "tool"; interaction: ToolInteraction };

  let currentGroup: ThinkingGroupItem[] = [];
  let groupCounter = 0;

  const flushGroup = () => {
    if (currentGroup.length === 0) return;

    // Create a stable groupId based on the first item in the group
    const firstItem = currentGroup[0];
    if (!firstItem) return; // Safety check

    let groupId: string;
    if (firstItem.kind === "thinking") {
      groupId = `thinking-group:${turnId}:${firstItem.block.sequence}`;
    } else {
      const source =
        firstItem.interaction.toolUse ?? firstItem.interaction.toolResult;
      groupId = `thinking-group:${turnId}:tool:${source?.sequence ?? groupCounter}`;
    }

    result.push({
      kind: "thinkingGroup",
      groupId,
      items: [...currentGroup],
    });
    currentGroup = [];
    groupCounter++;
  };

  for (const item of items) {
    if (item.kind === "block" && item.block.blockType === "thinking") {
      // Thinking block -> add to current group
      currentGroup.push({ kind: "thinking", block: item.block });
    } else if (item.kind === "toolInteraction") {
      // Only group tools with thinking if the group actually has thinking content
      // Otherwise, a standalone tool after text would get incorrectly grouped
      const hasThinkingInGroup = currentGroup.some(
        (i) => i.kind === "thinking",
      );
      if (hasThinkingInGroup) {
        currentGroup.push({ kind: "tool", interaction: item });
      } else {
        // No thinking started this group - render tool standalone
        flushGroup();
        result.push(item);
      }
    } else {
      // Non-thinking/non-tool item -> flush current group and add item as-is
      flushGroup();
      result.push(item);
    }
  }

  // Flush any remaining group
  flushGroup();

  return result;
}

/**
 * Groups consecutive standalone tool interactions (not in a thinking group)
 * into a single collapsible "tool group" for cleaner UI presentation.
 *
 * Only groups if 2+ consecutive tools exist. Single standalone tools stay as-is.
 *
 * This is a third pass over the already-grouped render items.
 */
export function groupStandaloneTools(
  items: AssistantRenderItem[],
  turnId: string,
): AssistantRenderItem[] {
  const result: AssistantRenderItem[] = [];
  let currentToolRun: ToolInteraction[] = [];

  const flushToolRun = () => {
    if (currentToolRun.length === 0) return;

    if (currentToolRun.length === 1) {
      // Single tool stays standalone
      const tool = currentToolRun[0]!;
      result.push({
        kind: "toolInteraction",
        toolUse: tool.toolUse,
        toolResult: tool.toolResult,
      });
    } else {
      // 2+ tools get grouped
      const firstTool = currentToolRun[0]!;
      const source = firstTool.toolUse ?? firstTool.toolResult;
      const groupId = `tool-group:${turnId}:${source?.sequence ?? 0}`;

      result.push({
        kind: "toolGroup",
        groupId,
        items: [...currentToolRun],
      });
    }
    currentToolRun = [];
  };

  for (const item of items) {
    if (item.kind === "toolInteraction") {
      // Accumulate consecutive tool interactions
      currentToolRun.push({
        toolUse: item.toolUse,
        toolResult: item.toolResult,
      });
    } else {
      // Non-tool item: flush accumulated tools and pass through
      flushToolRun();
      result.push(item);
    }
  }

  // Flush any remaining tools at the end
  flushToolRun();

  return result;
}
