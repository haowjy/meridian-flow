/**
 * Streaming helpers: map gateway StreamEvents to OrchestratorEvents and
 * ContentParts to block rows. Owns the stream-event → block projection
 * consumed by the orchestrator loop.
 *
 * Key boundaries:
 *
 * - `mapStreamEvent`: projects the gateway's provider-neutral `StreamEvent`
 *   (text.delta, reasoning.delta, tool_call.delta) into
 *   `OrchestratorEvent.stream.delta`. Only text/reasoning/tool_call deltas
 *   are mapped; `start`, `usage`, `end`, `error`, and `custom.delta` are
 *   dropped here (the orchestrator handles end/error directly).
 *
 * - **partIndex is dropped**: `StreamEvent` carries an optional `partIndex`
 *   (the position within the output item, supplied by the adapter), but
 *   `OrchestratorEvent.stream.delta` has no position field. This is a real,
 *   current limitation — the client cannot reconstruct intra-item ordering
 *   from stream deltas alone; it relies on the final assembled blocks in
 *   `block.upserted` events for positional truth.
 *
 * - `collectToolCalls`: merges tool calls from `result.content[]` (the
 *   assembled content parts, which include `tool_use` parts) and
 *   `result.toolCalls[]` (a flat list of all tool calls). Deduplicates by
 *   `toolCallId` so calls appearing in both lists aren't double-counted.
 *
 * - `contentPartToBlockInput`: maps each assembled `ContentPart` to a
 *   block create input using the turn-scoped `sequence` counter allocated
 *   by the orchestrator.
 *
 * - `toJsonValue`: a `JSON.parse(JSON.stringify())` round-trip that coerces
 *   runtime objects into the `JsonValue` union (`string | number | boolean |
 *   null | JsonValue[] | { [key: string]: JsonValue }`).  `undefined` values
 *   are converted to `null` because `undefined` is not a valid JSON value.
 */
import type { JsonValue, Turn } from "@meridian/contracts/threads";
import type { BlockRepository } from "../../threads/index.js";
import type { ContentPart, GenerateResult, StreamEvent, ToolCall } from "../gateway/index.js";

export function toJsonValue(value: unknown): JsonValue {
  // JSON round-trip: strips functions, symbols, BigInts, and cyclic refs;
  // coerces `undefined` → `null` (undefined is not valid JSON).
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function mapStreamEvent(event: StreamEvent) {
  // Maps gateway StreamEvent → OrchestratorEvent.stream.delta.
  // NOTE: event.partIndex is intentionally dropped — the stream.delta
  // contract has no position field. The client must reconstruct block
  // ordering from the final block.upserted events, not from deltas.
  switch (event.type) {
    case "text.delta":
      return { type: "stream.delta", kind: "text", text: event.text } as const;
    case "reasoning.delta":
      return { type: "stream.delta", kind: "reasoning", text: event.text } as const;
    case "tool_call.delta":
      return {
        type: "stream.delta",
        kind: "tool_call",
        toolCallId: event.id,
        toolName: event.name,
        argumentsDelta: event.argumentsDelta,
      } as const;
    default:
      // start, usage, end, error, custom.delta — handled by the orchestrator
      // directly (or dropped for custom.delta which has no block mapping).
      return null;
  }
}

// Merges tool_use content parts + the flat toolCalls[] list, deduplicating
// by toolCallId. The normal case is that tool calls already appear as
// tool_use parts in content[] (Anthropic / OpenAI Responses). The
// result.toolCalls[] list is a fallback for adapters that report calls
// outside the content array.  Order: content[] parts come first (preserving
// adapter output order), then any extra toolCalls[] entries appended.
export function collectToolCalls(result: GenerateResult): ToolCall[] {
  const fromContent = result.content
    .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
    .map((p) => ({
      id: p.toolCallId,
      name: p.toolName,
      arguments: p.input,
    }));
  const seen = new Set(fromContent.map((c) => c.id));
  for (const call of result.toolCalls) {
    if (!seen.has(call.id)) {
      fromContent.push(call);
      seen.add(call.id);
    }
  }
  return fromContent;
}

// Projects a fully assembled ContentPart into a block create input.
// `sequence` is the turn-scoped monotonic counter allocated by the
// orchestrator.  Returns `null` for content types that don't map to blocks
// (e.g. image/file/custom — these need a content-serialization layer before
// they can become blocks).  reasoning parts store both `textContent` (for
// simple text display) and `content` (a JSON value with providerOptions
// preserved).
export function contentPartToBlockInput(
  part: ContentPart,
  turnId: Turn["id"],
  sequence: number,
  responseId: string,
  provider: string,
): Parameters<BlockRepository["create"]>[0] | null {
  switch (part.type) {
    case "text":
      return {
        turnId,
        blockType: "text",
        sequence,
        responseId,
        textContent: part.text,
        provider,
        status: "complete",
      };
    case "reasoning":
      return {
        turnId,
        blockType: "reasoning",
        sequence,
        responseId,
        textContent: part.text,
        content: toJsonValue({
          text: part.text,
          ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
        }),
        provider,
        status: "complete",
      };
    case "tool_use":
      return {
        turnId,
        blockType: "tool_use",
        sequence,
        responseId,
        content: {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: toJsonValue(part.input),
        },
        provider,
        status: "complete",
      };
    default:
      // image, file, custom — need a content-serialization layer.
      return null;
  }
}
