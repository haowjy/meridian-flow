import { displayContextUri } from "@meridian/contracts/context-uri";
import type { JsonValue, ToolContentPart } from "@meridian/contracts/threads";

export function textContent(text: string): ToolContentPart[] {
  return [{ type: "text", text: text.length > 0 ? displayContextUri(text) : '""' }];
}

export function jsonContent(value: JsonValue): ToolContentPart[] {
  return textContent(typeof value === "string" ? value : JSON.stringify(value));
}

export function renderAsText<Args extends unknown[]>(
  render: (...args: Args) => string,
): (...args: Args) => ToolContentPart[] {
  return (...args) => textContent(render(...args));
}
