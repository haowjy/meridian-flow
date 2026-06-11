import type { Block, JsonValue } from "./index.js";

export function blockContentRecord(block: Block): Record<string, JsonValue> {
  return block.content && typeof block.content === "object" && !Array.isArray(block.content)
    ? (block.content as Record<string, JsonValue>)
    : {};
}
