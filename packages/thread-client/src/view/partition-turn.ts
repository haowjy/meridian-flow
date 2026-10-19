/** partition-turn — folds an ordered `Block[]` into render items: process folds, prose, reports and artifacts. */
import { parseInvocationCard } from "@meridian/contracts/components";
import { isArtifactRef } from "@meridian/contracts/interrupt";
import {
  type Block,
  blockContentRecord,
  blockPlainText,
  type JsonValue,
} from "@meridian/contracts/protocol";
import type { SavedReportContentValue as ReportContentValue } from "@meridian/contracts/spawn";
import { isToolDeliveryBlock } from "./block-kind";
import { componentBlockContent } from "./component-block-content";
import { type DeliverySegment, groupDeliverySegments } from "./group-delivery-segments";
import { toolInputObject } from "./tool-command";
import { isArtifactBlock } from "./tool-kind";
import { isNotesStepHeldResult, isToolViewVisible } from "./tool-view-visibility";

export type Run = { kind: "reasoning"; blocks: Block[] } | { kind: "activity"; blocks: Block[] };

export type RenderItem =
  | { kind: "process"; runs: Run[] }
  | { kind: "text"; block: Block }
  | { kind: "report"; block: Block; report: ReportContentValue }
  | { kind: "artifact"; block: Block };

export function isReasoningBlock(block: Block): boolean {
  return block.blockType === "reasoning" || block.blockType === "thinking";
}

export function partitionTurn(blocks: Block[]): RenderItem[] {
  const segments = groupDeliverySegments(blocks);
  const hidden = hiddenToolCallIds(blocks, segments);
  const reports = new Map<Block, ReportContentValue>();
  const reportCalls = new Set<string>();
  for (const segment of segments) {
    const tools =
      segment.kind === "tool" ? [segment.tool] : segment.kind === "tool-run" ? segment.tools : [];
    for (const tool of tools) {
      if (
        tool.keyBlock.blockType !== "tool_use" ||
        tool.toolName !== "return_result" ||
        isNotesStepHeldResult(tool.result)
      )
        continue;
      const input = toolInputObject(tool);
      const result = isRecord(tool.result) ? tool.result : {};
      reports.set(tool.keyBlock, {
        summary: typeof input.summary === "string" ? input.summary : "",
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        artifacts: Array.isArray(input.artifacts) ? input.artifacts.filter(isArtifactRef) : [],
        partial: result.ok === false || tool.isError,
        ...(typeof result.message === "string" ? { reason: result.message } : {}),
      });
      if (tool.toolCallId) reportCalls.add(tool.toolCallId);
    }
  }
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
      const content = blockContentRecord(block);
      const toolCallId = content.toolCallId;
      const report = reports.get(block);
      if (report) {
        flushProcess();
        items.push({ kind: "report", block, report });
        continue;
      }
      if (
        block.blockType === "tool_result" &&
        typeof toolCallId === "string" &&
        reportCalls.has(toolCallId)
      ) {
        continue;
      }
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

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tool calls the writer sees elsewhere: a call whose helper card is in the
 * turn shows as that card alone, and the per-tool policy covers the rest. A
 * `thread_message` refused before it started has no card, so its failure row
 * stays.
 */
export function hiddenToolCallIds(
  blocks: Block[],
  segments: DeliverySegment[] = groupDeliverySegments(blocks),
): Set<string> {
  const hidden = new Set<string>();
  for (const block of blocks) {
    if (block.blockType !== "custom") continue;
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
