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
