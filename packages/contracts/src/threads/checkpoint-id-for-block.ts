/**
 * Purpose: Provides the canonical read-side checkpoint id detector for thread blocks.
 * Key decision: checkpoint identity is a JSON-natural custom-block field
 * (`content.checkpoint.id`), independent from any UI component rendering schema.
 */
import { blockContentRecord } from "./block-content-record.js";
import type { Block, JsonValue } from "./index.js";

/** Returns a custom block's non-empty `content.checkpoint.id`, or null when absent. */
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
