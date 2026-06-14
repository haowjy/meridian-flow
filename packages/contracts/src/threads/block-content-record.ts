/**
 * Purpose: Provides the canonical plain-record view of a thread block's JSON content.
 * Key decision: non-object and array content becomes an empty record so read-side
 * helpers can be null-safe without each caller re-implementing the same guard.
 */
import type { Block, JsonValue } from "./index.js";

/**
 * Returns a plain JSON object for `block.content`, or `{}` when the block stores
 * scalar, null, or array content. The returned record is read-only by convention:
 * callers use it to inspect cross-boundary JSON fields, not to mutate blocks.
 */
export function blockContentRecord(block: Block): Record<string, JsonValue> {
  return block.content && typeof block.content === "object" && !Array.isArray(block.content)
    ? (block.content as Record<string, JsonValue>)
    : {};
}
