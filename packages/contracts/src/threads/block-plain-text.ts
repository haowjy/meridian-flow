/**
 * Purpose: Derives display plain text from block content across durable and live projections.
 * Key decision: this stays in a dependency-light leaf so protocol can re-export
 * it without evaluating the full threads barrel and its golden fixtures.
 */
import type { BlockType, JsonValue } from "./index.js";

/**
 * Canonical plain-text derivation for a block, independent of how each block type
 * shapes its `content`. Text blocks store prose directly as a string `content`;
 * reasoning/thinking blocks wrap it as `{ text, providerOptions? }` to preserve
 * provider round-trip data. Single source of truth so durable projection, live
 * in-memory projection, and the renderer can't drift per block type. Returns null
 * for non-prose blocks or when no usable text is present.
 */
export function blockPlainText(blockType: BlockType, content: JsonValue): string | null {
  if (blockType !== "text" && blockType !== "reasoning" && blockType !== "thinking") {
    return null;
  }
  if (typeof content === "string") return content;
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return null;
}
