/**
 * Pure visibility policy shared by tool-row rendering and fold digests.
 * Protocol blocks stay hidden when a custom card is the sole writer-facing
 * surface: ask_user (interrupt card), spawn and a foreground thread_message
 * (helper-result card). A background thread_message has no card, so it shows
 * as a row once it settles. A child return_result is rendered as the child's report.
 */
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";
import { threadMessageRow } from "./thread-message-result";

export function isToolViewVisible(tool: ToolView): boolean {
  if (tool.toolName === "ask_user") return false;
  if (tool.toolName === "spawn") return false;
  if (tool.toolName === "thread_message") return threadMessageRow(tool) !== null;
  if (tool.toolName === "tool" && isInterruptResultOutput(tool.output)) return false;
  return true;
}

function isInterruptResultOutput(output: JsonValue | null): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, JsonValue>;
  return "provenance" in record && "value" in record;
}
