import { type Block, blockContentRecord, type JsonValue } from "@meridian/contracts/protocol";

import { isToolDeliveryBlock } from "./block-kind";

export type ToolView = {
  toolCallId: string | null;
  toolName: string;
  input: JsonValue | null;
  result: JsonValue | null;
  status: "partial" | "complete";
  isError: boolean;
  message: string | null;
  streamedOutput: string | null;
  connectionCalls: JsonValue[] | null;
  metadata: Record<string, JsonValue> | null;
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
  connectionCalls: JsonValue[] | null;
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
    if (!isToolDeliveryBlock(block)) {
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
    connectionCalls: fields.connectionCalls,
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
  if (fields.streamedOutput && fields.streamedOutput.length > 0) {
    view.streamedOutput = fields.streamedOutput;
  }
  if (fields.connectionCalls) view.connectionCalls = fields.connectionCalls;
  if (fields.metadata) view.metadata = fields.metadata;
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
    connectionCalls: fields.connectionCalls,
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
    connectionCalls: Array.isArray(content.connectionCalls) ? content.connectionCalls : null,
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
