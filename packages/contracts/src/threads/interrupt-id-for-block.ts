/**
 * Purpose: Provides the canonical read-side interrupt id detector for thread blocks.
 * Key decision: interrupt identity is a JSON-natural custom-block field
 * (`content.interrupt.id`), independent from any UI component rendering schema.
 */
import { blockContentRecord } from "./block-content-record.js";
import type { Block, JsonValue } from "./index.js";

/** Returns a custom block's non-empty `content.interrupt.id`, or null when absent. */
export function interruptIdForBlock(block: Block): string | null {
  if (block.blockType !== "custom") return null;
  const interrupt = blockContentRecord(block).interrupt;
  if (!isJsonRecord(interrupt)) return null;
  const id = interrupt.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
