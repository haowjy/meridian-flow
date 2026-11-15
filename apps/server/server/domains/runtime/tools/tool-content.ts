/** What the model reads of a tool result, as the parts stored on its `tool_result` block. */
import { displayContextUri } from "@meridian/contracts/context-uri";
import type { JsonValue, ToolContentPart } from "@meridian/contracts/threads";

/**
 * One text part, with Agents addresses spelled `.agents/…`: the model never reads `agents://`.
 * Providers reject an empty tool result, so empty text is stored as `""`.
 */
export function textContent(text: string): ToolContentPart[] {
  return [{ type: "text", text: text.length > 0 ? displayContextUri(text) : '""' }];
}

/** A tool with no renderer shows the model its value: a string as it is, anything else as JSON. */
export function jsonContent(value: JsonValue): ToolContentPart[] {
  return textContent(typeof value === "string" ? value : JSON.stringify(value));
}

/** Adapts a renderer that returns text to the registration's `renderResult`. */
export function renderAsText<Args extends unknown[]>(
  render: (...args: Args) => string,
): (...args: Args) => ToolContentPart[] {
  return (...args) => textContent(render(...args));
}
