import type { BlockType, JsonValue } from "./index.js";

export function blockPlainText(blockType: BlockType, content: JsonValue): string | null {
  if (blockType !== "text" && blockType !== "thinking") {
    return null;
  }
  if (typeof content === "string") return content;
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return null;
}
