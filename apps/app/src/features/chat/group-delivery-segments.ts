/**
 * group-delivery-segments — converts delivery blocks into render segments.
 *
 * Adjacent raw tool protocol blocks are paired into logical ToolViews before
 * grouping so live (`tool_use` with output) and durable (`tool_use` +
 * `tool_result`) shapes produce the same delivery segment model before React
 * rendering.
 */
import { type Block, blockContentRecord, type JsonValue } from "@meridian/contracts/protocol";

import { isImageBlock, isToolDeliveryBlock } from "./block-kind";

export type ToolView = {
  toolCallId: string | null;
  toolName: string;
  input: JsonValue | null;
  output: JsonValue | null;
  status: "partial" | "complete";
  isError: boolean;
  message: string | null;
  /**
   * Append-only interleaved stdout+stderr buffer streamed via
   * `meridian.tool.output_delta` while the tool is running. Distinct from
   * `output` (the structured final result). Kept past completion so the
   * card can still surface the live log inside expandable details.
   * `null` when the wire never produced a delta.
   */
  streamedOutput: string | null;
  /** Render identity source: the `tool_use` block, or a stray `tool_result` when no use exists. */
  keyBlock: Block;
};

export type DeliverySegment =
  | { kind: "block"; block: Block }
  | { kind: "tool"; tool: ToolView }
  | { kind: "tool-run"; tools: ToolView[] };

type ToolFields = {
  toolCallId: string | null;
  toolName: string | null;
  input: JsonValue | null;
  output: JsonValue | null;
  isError: boolean;
  message: string | null;
  streamedOutput: string | null;
};

export function groupDeliverySegments(blocks: Block[]): DeliverySegment[] {
  const segments: DeliverySegment[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (!block) break;

    if (!isToolDeliveryBlock(block) || isImageBlock(block)) {
      segments.push({ kind: "block", block });
      index += 1;
      continue;
    }

    const run: Block[] = [];
    while (index < blocks.length) {
      const next = blocks[index];
      if (!next || !isToolDeliveryBlock(next) || isImageBlock(next)) break;
      run.push(next);
      index += 1;
    }

    const tools = pairToolViews(run);
    if (tools.length === 1) {
      const only = tools[0];
      if (only) segments.push({ kind: "tool", tool: only });
    } else if (tools.length > 1) {
      segments.push({ kind: "tool-run", tools });
    }
  }

  return segments;
}

function toToolView(block: Block): ToolView {
  const fields = readToolFields(blockContentRecord(block));

  return {
    toolCallId: fields.toolCallId,
    toolName: fields.toolName ?? "tool",
    input: fields.input,
    output: fields.output,
    status: fields.isError || block.status !== "partial" ? "complete" : "partial",
    isError: fields.isError,
    message: fields.message,
    streamedOutput: fields.streamedOutput,
    keyBlock: block,
  };
}

function pairToolViews(blocks: Block[]): ToolView[] {
  const viewsByUseBlock = new Map<Block, ToolView>();
  const firstViewByToolCallId = new Map<string, ToolView>();
  const pairedResults = new Set<Block>();

  for (const block of blocks) {
    if (block.blockType !== "tool_use") continue;
    const view = toToolView(block);
    viewsByUseBlock.set(block, view);
    if (view.toolCallId && !firstViewByToolCallId.has(view.toolCallId)) {
      firstViewByToolCallId.set(view.toolCallId, view);
    }
  }

  for (const block of blocks) {
    if (block.blockType !== "tool_result") continue;
    const resultToolCallId = toolCallIdForResult(block);
    const matchingView = resultToolCallId ? firstViewByToolCallId.get(resultToolCallId) : undefined;
    if (!matchingView) continue;
    mergeToolResult(matchingView, block);
    pairedResults.add(block);
  }

  blocks.forEach((block, index) => {
    if (block.blockType !== "tool_result" || pairedResults.has(block)) return;
    const previous = blocks[index - 1];
    const previousView = previous ? viewsByUseBlock.get(previous) : undefined;
    // Some providers omit tool-call ids from one or both halves; only then is
    // adjacency trusted, because id-based matching is the durable primary key.
    if (!previousView || previousView.toolCallId || toolCallIdForResult(block)) return;
    mergeToolResult(previousView, block);
    pairedResults.add(block);
  });

  const toolViews: ToolView[] = [];
  for (const block of blocks) {
    if (block.blockType === "tool_use") {
      const view = viewsByUseBlock.get(block);
      if (view) toolViews.push(view);
      continue;
    }
    if (block.blockType === "tool_result" && !pairedResults.has(block)) {
      toolViews.push(toolResultOnlyView(block));
    }
  }

  return toolViews;
}

function mergeToolResult(view: ToolView, resultBlock: Block): void {
  const fields = readToolFields(blockContentRecord(resultBlock));
  view.output = fields.output;
  view.isError = fields.isError;
  view.status = "complete";
  // Prefer the most-complete non-empty buffer: the live `tool_use` block
  // accumulates deltas during streaming, but on cold-load of a durable thread
  // the same buffer may have been persisted onto the `tool_result` block.
  if (fields.streamedOutput && fields.streamedOutput.length > 0) {
    view.streamedOutput = fields.streamedOutput;
  }
}

function toolResultOnlyView(block: Block): ToolView {
  const fields = readToolFields(blockContentRecord(block));
  return {
    toolCallId: fields.toolCallId,
    toolName: fields.toolName ?? "tool",
    input: null,
    output: fields.output,
    status: "complete",
    isError: fields.isError,
    message: fields.message,
    streamedOutput: fields.streamedOutput,
    keyBlock: block,
  };
}

function toolCallIdForResult(block: Block): string | null {
  return readToolFields(blockContentRecord(block)).toolCallId;
}

function readToolFields(content: Record<string, JsonValue>): ToolFields {
  return {
    toolCallId: stringField(content, "toolCallId"),
    toolName: stringField(content, "toolName"),
    input: jsonField(content, "input"),
    output: jsonField(content, "output"),
    isError: booleanField(content, "isError") ?? false,
    message: stringField(content, "message"),
    streamedOutput: stringField(content, "streamedOutput"),
  };
}

function stringField(content: Record<string, JsonValue>, key: string): string | null {
  const value = content[key];
  return typeof value === "string" ? value : null;
}

function booleanField(content: Record<string, JsonValue>, key: string): boolean | null {
  const value = content[key];
  return typeof value === "boolean" ? value : null;
}

function jsonField(content: Record<string, JsonValue>, key: string): JsonValue | null {
  if (!Object.hasOwn(content, key)) return null;
  return content[key] ?? null;
}
