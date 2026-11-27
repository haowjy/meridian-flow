import type { JsonValue, Turn } from "@meridian/contracts/threads";
import type {
  ContentPart,
  GenerateResult,
  StreamEvent,
  ToolCall,
} from "@meridian-flow/runtime/gateway";
import type { BlockRepository } from "../../threads/index.js";

export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function mapStreamEvent(event: StreamEvent) {
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
      return null;
  }
}

export class DuplicateToolCallIdError extends Error {
  constructor(readonly toolCallId: string) {
    super(`The model reused tool call id ${toolCallId} in one response`);
    this.name = "DuplicateToolCallIdError";
  }
}

export function collectToolCalls(result: GenerateResult): ToolCall[] {
  const calls = result.content
    .filter((p): p is Extract<ContentPart, { type: "tool_use" }> => p.type === "tool_use")
    .map((p) => ({
      id: p.toolCallId,
      name: p.toolName,
      arguments: p.input,
      ...(p.inputParseError ? { argumentsParseError: p.inputParseError } : {}),
    }));
  const seen = new Set<string>();
  for (const { id } of calls) {
    if (seen.has(id)) throw new DuplicateToolCallIdError(id);
    seen.add(id);
  }
  return calls;
}

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
      return null;
  }
}
