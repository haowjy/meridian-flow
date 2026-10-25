/** partition-turn — folds normalized delivery segments into render items: process folds, prose, reports and artifacts. */

import { isArtifactRef } from "@meridian/contracts/artifacts";
import { parseInvocationCard } from "@meridian/contracts/components";
import { type Block, blockPlainText, type JsonValue } from "@meridian/contracts/protocol";
import type { SavedReportContentValue as ReportContentValue } from "@meridian/contracts/spawn";
import { isNotesStepHeldResult } from "@meridian/contracts/threads";
import { componentBlockContent } from "./component-block-content";
import type { DeliverySegment, ToolView } from "./group-delivery-segments";
import { toolInputObject } from "./tool-command";
import { isToolViewVisible } from "./tool-view-visibility";

export type Run =
  | { kind: "reasoning"; blocks: Block[] }
  | { kind: "activity"; blocks: Block[]; tools: ToolView[] };

export type RenderItem =
  | { kind: "process"; runs: Run[] }
  | { kind: "text"; block: Block }
  | { kind: "report"; block: Block; report: ReportContentValue }
  | { kind: "artifact"; block: Block };

function isReasoningBlock(block: Block): boolean {
  return block.blockType === "reasoning" || block.blockType === "thinking";
}

export function partitionTurn(
  segments: DeliverySegment[],
  hidden: ReadonlySet<string>,
): RenderItem[] {
  const items: RenderItem[] = [];
  let runs: Run[] | null = null;

  const flushProcess = () => {
    if (runs && runs.length > 0) items.push({ kind: "process", runs });
    runs = null;
  };
  const pushTool = (tool: ToolView) => {
    if (!runs) runs = [];
    const last = runs[runs.length - 1];
    if (last?.kind === "activity") {
      last.blocks.push(tool.keyBlock);
      last.tools.push(tool);
    } else runs.push({ kind: "activity", blocks: [tool.keyBlock], tools: [tool] });
  };
  for (const segment of segments) {
    if (segment.kind !== "block") {
      const tools = segment.kind === "tool" ? [segment.tool] : segment.tools;
      for (const tool of tools) {
        if (
          tool.keyBlock.blockType === "tool_use" &&
          tool.toolName === "return_result" &&
          !isNotesStepHeldResult(tool.result)
        ) {
          const input = toolInputObject(tool);
          const result = isRecord(tool.result) ? tool.result : {};
          flushProcess();
          items.push({
            kind: "report",
            block: tool.keyBlock,
            report: {
              summary: typeof input.summary === "string" ? input.summary : "",
              ...(input.payload === undefined ? {} : { payload: input.payload }),
              artifacts: Array.isArray(input.artifacts)
                ? input.artifacts.filter(isArtifactRef)
                : [],
              partial: result.ok === false || tool.isError,
              ...(typeof result.message === "string" ? { reason: result.message } : {}),
            },
          });
        } else if (!tool.toolCallId || !hidden.has(tool.toolCallId)) pushTool(tool);
      }
      continue;
    }
    const { block } = segment;
    if (isReasoningBlock(block)) {
      if (hasVisibleReasoningText(block)) {
        if (!runs) runs = [];
        const last = runs[runs.length - 1];
        if (last?.kind === "reasoning") last.blocks.push(block);
        else runs.push({ kind: "reasoning", blocks: [block] });
      }
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

    // Cards, images and unknown blocks remain outside the process fold.
    flushProcess();
    items.push({ kind: "artifact", block });
  }

  flushProcess();
  return items;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tool calls the writer sees elsewhere: a call whose helper card is in the
 * turn shows as that card alone, and the per-tool policy covers the rest. A
 * `thread_message` refused before it started has no card, so its failure row
 * stays.
 */
export function hiddenToolCallIds(segments: DeliverySegment[]): Set<string> {
  const hidden = new Set<string>();
  for (const segment of segments) {
    if (segment.kind !== "block" || segment.block.blockType !== "custom") continue;
    const { block } = segment;
    const card = parseInvocationCard(componentBlockContent(block.content));
    if (card) hidden.add(card.toolCallId);
  }
  for (const segment of segments) {
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
