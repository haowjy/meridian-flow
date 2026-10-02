import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { Block, JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";

export function block(
  id: string,
  sequence: number,
  blockType: Block["blockType"],
  content: JsonValue,
): Block {
  return {
    id,
    turnId: "parent-turn",
    responseId: null,
    blockType,
    sequence,
    content,
    status: "complete",
    textContent: null,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

export function toolView({
  toolCallId,
  toolName,
  output,
  result = null,
  isError = false,
  sequence = 1,
  input = null,
  message = null,
}: {
  toolCallId: string;
  toolName: string;
  output: JsonValue;
  result?: JsonValue | null;
  isError?: boolean;
  sequence?: number;
  input?: JsonValue | null;
  message?: string | null;
}): ToolView {
  return {
    toolCallId,
    toolName,
    input,
    output,
    result,
    status: "complete",
    isError,
    message,
    streamedOutput: null,
    metadata: null,
    keyBlock: block(`tool-${toolCallId}`, sequence, "tool_use", { toolCallId, toolName }),
  };
}

export const savedArtifact: ArtifactRef = {
  type: "object",
  uri: "scratch://saved.md",
  label: "Saved artifact",
};
