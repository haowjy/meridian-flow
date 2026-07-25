/**
 * Pure visibility policy shared by tool-row rendering and fold digests.
 * Interrupt protocol blocks stay hidden because the custom interrupt card is
 * their sole writer-facing surface.
 */
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";

export function isToolViewVisible(tool: ToolView): boolean {
  if (tool.toolName === "ask_user") return false;
  if (tool.toolName === "tool" && isInterruptResultOutput(tool.output)) return false;
  return true;
}

function isInterruptResultOutput(output: JsonValue | null): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, JsonValue>;
  return "provenance" in record && "value" in record;
}
