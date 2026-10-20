/**
 * group-delivery-segments — converts delivery blocks into render segments.
 *
 * Raw tool protocol blocks are paired across the whole turn before ordered
 * grouping so live (`tool_use` with its result) and durable (`tool_use` +
 * `tool_result`) shapes produce the same delivery segment model before React
 * rendering.
 */
import { type Block, blockContentRecord, type JsonValue } from "@meridian/contracts/protocol";

import { isImageBlock, isToolDeliveryBlock } from "./block-kind";

export type ToolView = {
  toolCallId: string | null;
  toolName: string;
  input: JsonValue | null;
  /**
   * The tool's typed result. Renderers read fields here. The model's text
   * (`output` on the block) is deliberately absent: the app never parses it.
   * `null` while the call runs.
   */
  result: JsonValue | null;
  status: "partial" | "complete";
  isError: boolean;
  message: string | null;
  /**
   * Append-only interleaved stdout+stderr buffer streamed via
   * `meridian.tool.output_delta` while the tool is running. Distinct from
   * `result` (the structured final result). Kept past completion so the
   * card can still surface the live log inside expandable details.
   * `null` when the wire never produced a delta.
   */
  streamedOutput: string | null;
  /**
   * Server-authored result metadata persisted beside the result — never
   * model-authored. Carried as `content.metadata` on the durable tool_result
   * block and as `metadata` on the live `tool.result` event; this is where
   * the `work` tool's receipt (`metadata.workReceipt`) rides.
   */
  metadata: Record<string, JsonValue> | null;
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
  result: JsonValue | null;
  isError: boolean;
  message: string | null;
  streamedOutput: string | null;
  metadata: Record<string, JsonValue> | null;
};

export function groupDeliverySegments(blocks: Block[]): DeliverySegment[] {
  const segments: DeliverySegment[] = [];
  const views = pairToolViews(blocks);
  let run: ToolView[] = [];
  const flush = () => {
    const only = run[0];
    if (run.length === 1 && only) segments.push({ kind: "tool", tool: only });
    else if (run.length > 1) segments.push({ kind: "tool-run", tools: run });
    run = [];
  };
  for (const block of blocks) {
    if (!isToolDeliveryBlock(block) || isImageBlock(block)) {
      flush();
      segments.push({ kind: "block", block });
    } else {
      const view = views.get(block);
      if (view) run.push(view);
    }
  }
  flush();
  return segments;
}

function toToolView(block: Block): ToolView {
  const fields = readToolFields(blockContentRecord(block));

  return {
    toolCallId: fields.toolCallId,
    toolName: fields.toolName ?? "tool",
    input: fields.input,
    result: fields.result,
    status: fields.isError || block.status !== "partial" ? "complete" : "partial",
    isError: fields.isError,
    message: fields.message,
    streamedOutput: fields.streamedOutput,
    metadata: fields.metadata,
    keyBlock: block,
  };
}

function pairToolViews(blocks: Block[]): Map<Block, ToolView> {
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

  for (const block of blocks) {
    if (block.blockType === "tool_result" && !pairedResults.has(block)) {
      viewsByUseBlock.set(block, toolResultOnlyView(block));
    }
  }
  return viewsByUseBlock;
}

function mergeToolResult(view: ToolView, resultBlock: Block): void {
  const fields = readToolFields(blockContentRecord(resultBlock));
  view.result = fields.result;
  view.isError = fields.isError;
  view.status = "complete";
  // Prefer the most-complete non-empty buffer: the live `tool_use` block
  // accumulates deltas during streaming, but on cold-load of a durable thread
  // the same buffer may have been persisted onto the `tool_result` block.
  if (fields.streamedOutput && fields.streamedOutput.length > 0) {
    view.streamedOutput = fields.streamedOutput;
  }
  if (fields.metadata) view.metadata = fields.metadata;
  // Process folds can be partitioned by intervening prose. Carry the paired
  // result on the use so later per-fold grouping cannot lose its outcome.
  view.keyBlock = {
    ...view.keyBlock,
    status: "complete",
    content: {
      ...blockContentRecord(view.keyBlock),
      result: view.result,
      isError: view.isError,
      streamedOutput: view.streamedOutput,
      metadata: view.metadata,
    },
  };
}

function toolResultOnlyView(block: Block): ToolView {
  const fields = readToolFields(blockContentRecord(block));
  return {
    toolCallId: fields.toolCallId,
    toolName: fields.toolName ?? "tool",
    input: null,
    result: fields.result,
    status: "complete",
    isError: fields.isError,
    message: fields.message,
    streamedOutput: fields.streamedOutput,
    metadata: fields.metadata,
    keyBlock: block,
  };
}

function toolCallIdForResult(block: Block): string | null {
  return readToolFields(blockContentRecord(block)).toolCallId;
}

function readToolFields(content: Record<string, JsonValue>): ToolFields {
  return {
    toolCallId: stringField(content, "toolCallId") ?? stringField(content, "toolUseId"),
    toolName: stringField(content, "toolName"),
    input: jsonField(content, "input"),
    result: jsonField(content, "result"),
    isError: booleanField(content, "isError") ?? false,
    message: stringField(content, "message"),
    streamedOutput: stringField(content, "streamedOutput"),
    metadata: recordField(content, "metadata"),
  };
}

function stringField(content: Record<string, JsonValue>, key: string): string | null {
  const value = content[key];
  return typeof value === "string" ? value : null;
}

function recordField(
  content: Record<string, JsonValue>,
  key: string,
): Record<string, JsonValue> | null {
  const value = content[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function booleanField(content: Record<string, JsonValue>, key: string): boolean | null {
  const value = content[key];
  return typeof value === "boolean" ? value : null;
}

function jsonField(content: Record<string, JsonValue>, key: string): JsonValue | null {
  if (!Object.hasOwn(content, key)) return null;
  return content[key] ?? null;
}
