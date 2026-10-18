/** Decodes saved tool records for model replay, retaining incomplete records as explicit text. */
import type { Block, JsonObject } from "@meridian/contracts/threads";
import { type EventSink, emitEvent } from "../../observability/index.js";
import { text } from "../gateway/helpers/messages.js";
import { isNonBlankToolIdentity } from "../gateway/helpers/tool-identity.js";
import type { TextPart, ToolResultPart, ToolUsePart } from "../gateway/index.js";

type ToolPart = (ToolUsePart & { input: JsonObject }) | ToolResultPart;
type DecodedTool = { part: ToolPart; fields: [] } | { part: null; fields: string[] };

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodeToolBlock(block: Block): DecodedTool {
  if (block.blockType !== "tool_use" && block.blockType !== "tool_result")
    return { part: null, fields: ["blockType"] };
  const content = block.content;
  if (!object(content)) return { part: null, fields: ["content"] };
  const fields: string[] = [];
  if (!isNonBlankToolIdentity(content.toolCallId)) fields.push("toolCallId");
  if (block.blockType === "tool_use") {
    if (!isNonBlankToolIdentity(content.toolName)) fields.push("toolName");
    // Preserve the existing absent-input representation; a supplied value must be an object.
    if (content.input !== undefined && !object(content.input)) fields.push("input");
    if (fields.length) return { part: null, fields };
    return {
      part: {
        type: "tool_use",
        toolCallId: content.toolCallId as string,
        toolName: content.toolName as string,
        input: (content.input ?? {}) as JsonObject,
      },
      fields: [],
    };
  }
  if (content.isError !== undefined && typeof content.isError !== "boolean") fields.push("isError");
  if (fields.length) return { part: null, fields };
  return {
    part: {
      type: "tool_result",
      toolCallId: content.toolCallId as string,
      output: content.output === undefined ? (block.textContent ?? null) : content.output,
      ...(content.isError !== undefined ? { isError: content.isError as boolean } : {}),
    },
    fields: [],
  };
}

/** Only fields already intended for the model may enter recovery text, never host result/metadata. */
function modelRecord(block: Block): JsonObject {
  const content = block.content;
  if (!object(content))
    return {
      contentType: content === null ? "null" : Array.isArray(content) ? "array" : typeof content,
    };
  const identity = (value: unknown) => (typeof value === "string" ? value : "[invalid identity]");
  return block.blockType === "tool_use"
    ? {
        toolCallId: identity(content.toolCallId),
        toolName: identity(content.toolName),
        ...(content.input !== undefined ? { input: content.input } : {}),
      }
    : {
        toolCallId: identity(content.toolCallId),
        output: content.output === undefined ? (block.textContent ?? null) : content.output,
        ...(typeof content.isError === "boolean" ? { isError: content.isError } : {}),
      };
}

/** A call group ends before the next assistant continuation. IDs may repeat in later responses. */
export function projectToolBlockGroup(
  blocks: readonly Block[],
  threadId: string,
  eventSink?: EventSink,
): Map<Block, ToolPart | TextPart> {
  const decoded = new Map<Block, DecodedTool>();
  const invalidIds = new Set<string>();
  for (const block of blocks) {
    if (block.blockType !== "tool_use" && block.blockType !== "tool_result") continue;
    const result = decodeToolBlock(block);
    decoded.set(block, result);
    if (!result.part && object(block.content) && isNonBlankToolIdentity(block.content.toolCallId)) {
      invalidIds.add(block.content.toolCallId);
    }
  }
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const { part } of decoded.values()) {
    if (!part) continue;
    const counts = part.type === "tool_use" ? calls : results;
    counts.set(part.toolCallId, (counts.get(part.toolCallId) ?? 0) + 1);
  }
  for (const [block, result] of decoded) {
    const part = result.part;
    if (!part) continue;
    if ((calls.get(part.toolCallId) ?? 0) > 1 || (results.get(part.toolCallId) ?? 0) > 1) {
      invalidIds.add(part.toolCallId);
      decoded.set(block, { part: null, fields: ["toolCallId_duplicate"] });
    } else if (part.type === "tool_result" && !calls.has(part.toolCallId)) {
      decoded.set(block, { part: null, fields: ["toolCallId_unmatched"] });
    }
  }
  const projected = new Map<Block, ToolPart | TextPart>();
  for (const [block, result] of decoded) {
    if (result.part && !invalidIds.has(result.part.toolCallId)) {
      projected.set(block, result.part);
      continue;
    }
    const fields = result.part ? ["paired_tool_record"] : result.fields;
    projected.set(
      block,
      text(
        `Saved ${block.blockType} record could not be replayed as a tool message (${fields.join(", ")}). ` +
          "Execution and side effects are unknown; re-read state before retrying. " +
          `Saved record: ${JSON.stringify(modelRecord(block))}`,
      ),
    );
    if (eventSink) {
      emitEvent(eventSink, {
        level: "warn",
        source: "runtime.context_builder",
        name: "chat.persisted_contract.invalid",
        correlation: { threadId, turnId: block.turnId },
        sensitivity: "safe",
        payload: { blockId: block.id, blockType: block.blockType, fields, recovery: "text" },
      });
    }
  }
  return projected;
}
