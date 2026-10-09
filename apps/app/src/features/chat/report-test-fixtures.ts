import type { Block, JsonValue } from "@meridian/contracts/protocol";

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
