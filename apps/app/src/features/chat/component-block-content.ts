// @ts-nocheck
/**
 * component-block-content — shared parser for custom component block payloads.
 *
 * Purpose: Validates the render-facing shape for custom component blocks: a
 * payload must name a registered component `kind` and carry object `props`.
 * Checkpoint id detection lives in @meridian/contracts so reducers and render
 * partitioning share the same looser protocol predicate.
 */
import type { ComponentBlockContent } from "@meridian/contracts/components";
import type { JsonValue } from "@meridian/contracts/threads";

export function componentBlockContent(content: JsonValue): ComponentBlockContent | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  if (typeof content.kind !== "string" || content.kind.length === 0) return null;
  if (!content.props || typeof content.props !== "object" || Array.isArray(content.props)) {
    return null;
  }
  return content as ComponentBlockContent;
}
