import { blockContentRecord } from "./block-content-record.js";
import type { Block, JsonValue } from "./index.js";

export function checkpointIdForBlock(block: Block): string | null {
  if (block.blockType !== "custom") return null;
  const checkpoint = blockContentRecord(block).checkpoint;
  if (!isJsonRecord(checkpoint)) return null;
  const id = checkpoint.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
